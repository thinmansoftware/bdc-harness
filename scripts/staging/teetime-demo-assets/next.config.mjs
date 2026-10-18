// Trusted prepared asset. No real service integration is permitted by this demo.
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: { cpus: 1 },
  outputFileTracingRoot: '/workspace/app',
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" }
      ]
    }];
  }
};
export default config;
