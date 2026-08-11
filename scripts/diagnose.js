// Works out WHY a site is down, not just that it is.
//
// A bare "Request timed out" doesn't tell you whether the domain expired, the
// certificate lapsed, the server is refusing connections, or a WAF is blocking
// us. This walks the stack in order -- DNS -> TCP -> TLS -> HTTP -- and reports
// the first layer that actually broke, with the evidence behind it.
//
// Uses only Node built-ins so it adds no dependencies, and only runs when a
// failure has already been confirmed, so it never slows the normal 5-minute loop.
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');

const PROBE_TIMEOUT_MS = 10000;

function withTimeout(promise, ms, onTimeout) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(onTimeout), ms)),
  ]);
}

async function probeDns(hostname) {
  const out = { ips: [], nameservers: [], error: null };
  try {
    out.ips = await withTimeout(dns.resolve4(hostname), PROBE_TIMEOUT_MS, []);
  } catch (err) {
    out.error = err.code || err.message;
  }
  // Nameservers are checked on the registrable domain: a missing NS record there
  // is the difference between "domain expired" and "one record was deleted".
  const parts = hostname.split('.');
  const base = parts.length > 2 ? parts.slice(-3).join('.') : hostname;
  try {
    out.nameservers = await withTimeout(dns.resolveNs(base), PROBE_TIMEOUT_MS, []);
  } catch {
    out.nameservers = [];
  }
  return out;
}

function probeTcp(host, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => done({ ok: true, ms: Date.now() - started }));
    socket.once('timeout', () => done({ ok: false, error: 'timed out' }));
    socket.once('error', (err) => done({ ok: false, error: err.code || err.message }));
    socket.connect(port, host);
  });
}

function probeTls(host) {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host, port: 443, servername: host, timeout: PROBE_TIMEOUT_MS, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        const authorized = socket.authorized;
        const authError = socket.authorizationError;
        socket.destroy();
        if (!cert || !cert.valid_to) return resolve({ ok: false, error: 'no certificate presented' });
        const expiry = new Date(cert.valid_to);
        resolve({
          ok: true,
          authorized,
          authError: authError ? String(authError) : null,
          validFrom: cert.valid_from,
          validTo: cert.valid_to,
          daysLeft: Math.round((expiry - Date.now()) / 86400000),
          issuer: (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || 'unknown',
          subject: (cert.subject && cert.subject.CN) || 'unknown',
          altNames: cert.subjectaltname || '',
        });
      }
    );
    socket.setTimeout(PROBE_TIMEOUT_MS, () => {
      socket.destroy();
      resolve({ ok: false, error: 'TLS handshake timed out' });
    });
    socket.once('error', (err) => {
      socket.destroy();
      resolve({ ok: false, error: err.code || err.message });
    });
  });
}

// Does plain HTTP work when HTTPS doesn't? That distinguishes a TLS-only problem
// from the whole server being unreachable.
async function probeHttpPort(host) {
  return probeTcp(host, 80);
}

/**
 * @param {{name:string,url:string}} site
 * @param {{error:string,statusCode:number|null}} result  the failing check
 * @param {{downPeers?: Map<string,string[]>}} context  ip -> other down site names
 */
async function diagnose(site, result, context = {}) {
  let hostname;
  try {
    hostname = new URL(site.url).hostname;
  } catch {
    return {
      category: 'config',
      headline: 'The stored URL is not valid',
      likelyCause: `"${site.url}" cannot be parsed as a URL.`,
      action: 'Fix the address for this site in the dashboard.',
      evidence: [],
    };
  }

  const evidence = [];
  const dnsResult = await probeDns(hostname);

  // ---- Layer 1: DNS ----
  // Only NXDOMAIN-class answers prove a domain is gone. A refused or timed-out
  // query means OUR resolver failed, and reporting that as "your domain expired"
  // would be exactly the kind of confidently-wrong alert this system must avoid.
  const RESOLVER_FAULTS = ['ECONNREFUSED', 'ETIMEDOUT', 'ESERVFAIL', 'EREFUSED', 'ETIMEOUT'];
  if (dnsResult.error && RESOLVER_FAULTS.includes(dnsResult.error)) {
    evidence.push(`DNS lookup for ${hostname} could not complete: ${dnsResult.error}`);
    return {
      category: 'unknown',
      headline: 'Could not determine the cause - DNS lookup failed on our side',
      likelyCause:
        `The monitor's own DNS resolver returned ${dnsResult.error}, so the domain could not be checked. ` +
        'This says nothing about the site itself.',
      action: 'Re-run a check from the dashboard. If the site keeps failing with a real error, the next alert will diagnose it properly.',
      evidence,
    };
  }

  if (dnsResult.error || dnsResult.ips.length === 0) {
    evidence.push(`DNS A lookup for ${hostname}: ${dnsResult.error || 'no records returned'}`);
    evidence.push(
      dnsResult.nameservers.length
        ? `Nameservers found: ${dnsResult.nameservers.join(', ')}`
        : 'No nameservers found for the domain'
    );
    const domainGone = dnsResult.nameservers.length === 0;
    return {
      category: 'dns',
      headline: domainGone ? 'The domain itself is not resolving' : 'The domain has no address record',
      likelyCause: domainGone
        ? 'The domain looks expired, deleted, or its nameservers were removed at the registrar.'
        : 'The domain exists and has nameservers, but the A record pointing to the web server is missing or was deleted.',
      action: domainGone
        ? 'Check the domain registration and renewal status at the registrar.'
        : 'Re-add the A record for this hostname in the DNS zone.',
      evidence,
    };
  }

  const ip = dnsResult.ips[0];
  evidence.push(`DNS resolves to ${dnsResult.ips.join(', ')}`);

  // Several sites failing on one IP means the shared server is the problem, not
  // each site individually -- the single most useful thing to know when a batch
  // of client sites goes dark at once.
  const peers = (context.downPeers && context.downPeers.get(ip)) || [];
  const otherPeers = peers.filter((n) => n !== site.name);

  // ---- Layer 2: TCP ----
  const tcp443 = await probeTcp(ip, 443);
  if (!tcp443.ok) {
    const tcp80 = await probeHttpPort(ip);
    evidence.push(`TCP connect to ${ip}:443 failed (${tcp443.error})`);
    evidence.push(tcp80.ok ? `TCP connect to ${ip}:80 succeeded` : `TCP connect to ${ip}:80 also failed (${tcp80.error})`);
    if (otherPeers.length) evidence.push(`Other down sites on the same IP: ${otherPeers.join(', ')}`);

    if (tcp80.ok) {
      return {
        category: 'tls',
        headline: 'The server answers on HTTP but not HTTPS',
        likelyCause: 'The web server is running, but nothing is listening on the secure port (443) or it is being blocked.',
        action: 'Check the SSL configuration and that port 443 is open on the server/firewall.',
        evidence,
        sharedWith: otherPeers,
      };
    }
    return {
      category: 'connection',
      headline: otherPeers.length ? 'The hosting server is unreachable (multiple sites affected)' : 'The server is not accepting connections',
      likelyCause: otherPeers.length
        ? `${otherPeers.length + 1} monitored sites share the address ${ip} and all are failing, so the server or its network is down rather than any one site.`
        : `Nothing is answering at ${ip} on either port. The server is off, crashed, or a firewall is dropping traffic.`,
      action: otherPeers.length
        ? 'Contact the hosting provider about the server at this address - this is one incident, not many.'
        : 'Check that the server is powered on and the firewall allows web traffic.',
      evidence,
      sharedWith: otherPeers,
    };
  }
  evidence.push(`TCP connect to ${ip}:443 succeeded in ${tcp443.ms}ms`);

  // ---- Layer 3: TLS ----
  const cert = await probeTls(hostname);
  if (!cert.ok) {
    evidence.push(`TLS handshake failed: ${cert.error}`);
    return {
      category: 'tls',
      headline: 'The secure connection could not be established',
      likelyCause: 'The server accepts connections but the SSL/TLS handshake fails, so no browser can load the site securely.',
      action: 'Check the SSL certificate installation on the server.',
      evidence,
      sharedWith: otherPeers,
    };
  }

  evidence.push(`Certificate: ${cert.subject}, issued by ${cert.issuer}, expires ${cert.validTo} (${cert.daysLeft} days)`);

  if (cert.daysLeft < 0) {
    return {
      category: 'tls',
      headline: 'The SSL certificate has expired',
      likelyCause: `The certificate expired ${Math.abs(cert.daysLeft)} day(s) ago, so browsers now block the site with a security warning.`,
      action: 'Renew the SSL certificate. If it is Let\'s Encrypt, the auto-renewal has stopped working.',
      evidence,
      sharedWith: otherPeers,
    };
  }
  if (!cert.authorized && cert.authError) {
    evidence.push(`Certificate validation error: ${cert.authError}`);
    evidence.push(`Certificate covers: ${cert.altNames}`);
    return {
      category: 'tls',
      headline: 'The SSL certificate is not valid for this address',
      likelyCause: `The certificate presented does not match ${hostname} (${cert.authError}).`,
      action: 'Reissue the certificate so it covers this exact hostname, or point monitoring at the hostname the certificate does cover.',
      evidence,
      sharedWith: otherPeers,
    };
  }

  // ---- Layer 4: HTTP ----
  const code = result.statusCode;
  if (code && code >= 500) {
    if (otherPeers.length) evidence.push(`Other down sites on the same IP: ${otherPeers.join(', ')}`);
    const cloudflareish = code === 502 || code === 503 || code === 504 || code === 521 || code === 522 || code === 526;
    return {
      category: 'server',
      headline: `The server returned an error (HTTP ${code})`,
      likelyCause: cloudflareish
        ? 'The site is reachable through its CDN/proxy, but the origin server behind it is failing to respond correctly - typically the web server or database is down.'
        : 'The application on the server crashed or hit a fatal error while building the page.',
      action: otherPeers.length
        ? 'Several sites on this server are failing together - check the shared server rather than each site.'
        : 'Check the web server and PHP/application error logs for the failure.',
      evidence,
      sharedWith: otherPeers,
    };
  }

  if (result.error && /keyword/i.test(result.error)) {
    return {
      category: 'content',
      headline: 'The page loads but its expected content is missing',
      likelyCause: 'The server returns a normal page, but the text this site is checked against is no longer on it - the site may be showing an error page, a blank template, or was redesigned.',
      action: 'Open the site and confirm it looks right, then update the expected keyword if the wording legitimately changed.',
      evidence,
      sharedWith: otherPeers,
    };
  }

  if (result.error && /looks broken|almost no content/i.test(result.error)) {
    return {
      category: 'content',
      headline: 'The page loads but shows a broken-site placeholder',
      likelyCause: 'The server responds successfully but the page content matches a known failure page (suspended account, database connection error, parked domain, or empty response).',
      action: 'Open the site directly - the hosting account or database is likely the issue.',
      evidence,
      sharedWith: otherPeers,
    };
  }

  // Everything below HTTP checked out, so the failure was transient or specific
  // to the request the monitor makes.
  evidence.push(`Reported failure: ${result.error || 'unknown'}`);
  return {
    category: 'unknown',
    headline: 'The site failed its check but every layer tested healthy',
    likelyCause:
      'DNS, the connection and the certificate are all fine right now. The failure was likely intermittent, or the server is slow/refusing this particular automated request.',
    action: 'Open the site in a browser. If it loads normally, this is likely load-related and worth watching rather than fixing.',
    evidence,
    sharedWith: otherPeers,
  };
}

module.exports = { diagnose };
