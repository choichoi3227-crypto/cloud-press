export class CloudflareSaaS {
  constructor(env) {
    this.env = env;
    this.zoneId = env.CLOUDFLARE_ZONE_ID;
    this.apiToken = env.CLOUDFLARE_API_TOKEN;
    this.apiUrl = `<https://api.cloudflare.com/client/v4/zones/${this.zoneId}/custom_hostnames>`;
  }

  async addCustomHostname(domain) {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        hostname: domain,
        ssl: {
          method: 'http', // Cloudflare will handle verification via HTTP challenge
          type: 'dv'      // Domain Validated certificate
        }
      })
    });
    const data = await response.json();
    if (!data.success) throw new Error(data.errors.map(e => e.message).join(', '));
    return data.result; // Contains custom_hostname_id, cname_target, cname_name
  }

  async getCustomHostnameStatus(customHostnameId) {
    const response = await fetch(`${this.apiUrl}/${customHostnameId}`, {
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json();
    if (!data.success) throw new Error(data.errors.map(e => e.message).join(', '));
    return data.result; // Contains ssl.status
  }

  async deleteCustomHostname(customHostnameId) {
    const response = await fetch(`${this.apiUrl}/${customHostnameId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json();
    if (!data.success) throw new Error(data.errors.map(e => e.message).join(', '));
    return data.success;
  }
}
