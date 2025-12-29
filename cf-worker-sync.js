// Cloudflare Worker 定时触发 CLIProxy 使用数据同步
// 部署到 CF Worker 后，配置 Cron 触发（如 */15 * * * *）
// 可使用环境变量：DASHBOARD_URL=https://your-domain.vercel.app，或直接修改下方常量

const DASHBOARD_URL = (globalThis.DASHBOARD_URL || "https://your-domain.vercel.app").replace(/\/$/, "");

const worker = {
  async scheduled() {
    if (!DASHBOARD_URL || DASHBOARD_URL.includes("your-domain")) {
      console.error("Set DASHBOARD_URL env or replace placeholder in cf-worker-sync.js");
      return;
    }

    const url = `${DASHBOARD_URL}/api/sync`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      console.error(`Sync failed: ${res.status} ${res.statusText}`);
    }
  }
};

export default worker;
