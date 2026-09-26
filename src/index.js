// 启动引导：探测模式 → 解析路径 → 加载配置 → 建服务 → 优雅退出（宪法 VII：模式探测结果必须写启动日志）
import { startApp } from './net/server.js';

async function main() {
  const app = await startApp();

  // 优雅退出：收到信号后关闭服务再退出（会话清理在 US3 接入）
  const shutdown = async (signal) => {
    console.log(`[webssh] 收到 ${signal}，正在退出…`);
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      console.error('[webssh] 退出时出错:', err.message);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[webssh] 启动失败:', err.message);
  process.exit(1);
});
