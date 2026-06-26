# Security Policy

## Supported versions

Security fixes are targeted at the latest minor release.

| Version | Supported |
| ------- | --------- |
| Latest minor release | Yes |
| Older releases | Best effort only |

## Responsible disclosure

Please do not report security vulnerabilities in public issues.

Use GitHub Security Advisories for this repository and choose **Report a vulnerability** to open a private advisory. If the advisory flow is unavailable, contact the repository maintainers and ask them to open a private security advisory for coordinated disclosure.

Include enough detail to reproduce the issue, such as the affected command, configuration, environment, and a minimal safe example. Do not include real secrets, customer data, private URLs, access tokens, or raw probe evidence unless the private advisory specifically requires it.

## Sensitive probe output

CheckWebHealth drives a real browser and captures evidence for CDN/WAF troubleshooting. Raw probe artifacts can contain sensitive data, including:

- `results-*.json` files
- `.har` files
- cookies and request headers
- IP addresses, ASN details, URLs, redirects, and vendor trace IDs
- screenshots or logs that may reveal session state or internal hostnames

Treat these files as sensitive. Do not commit them, attach them to public issues, or share them outside the intended investigation. Redact or minimize evidence before sharing, and prefer private GitHub Security Advisories for vulnerability reports.