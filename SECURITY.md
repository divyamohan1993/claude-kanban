# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Claude Kanban, please report it responsibly.

**Do not open a public issue for security vulnerabilities.**

Instead, please email **divyamohan1993** on GitHub or open a [private security advisory](https://github.com/divyamohan1993/claude-kanban/security/advisories/new).

### What to include

- Description of the vulnerability
- Steps to reproduce
- Affected version(s)
- Potential impact

### Response timeline

- **Acknowledgment**: Within 48 hours
- **Assessment**: Within 1 week
- **Fix**: Targeted within 2 weeks for critical/high severity

## Security Posture

This project has undergone two formal security audits (41 findings, 35 fixed). See [SECURITY-AUDIT.md](SECURITY-AUDIT.md) for full details.

### Key protections

- Argon2id password hashing (64MB memory, 3 iterations, timing-safe)
- JWT authentication with randomized secret per instance
- Rate limiting (token bucket, 60 req/s burst) with SSE connection cap
- CSP, HSTS, CORS, secure cookies, CSRF protection
- Path traversal protection on all file operations
- Command injection blocking on all spawn sites
- Input validation with length limits on all endpoints
- Webhook SSRF protection (blocks RFC1918, loopback, link-local)
- Admin server binds `127.0.0.1` only (kernel-level TCP reject)
- Graceful shutdown with connection draining

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| < 2.0   | No        |
