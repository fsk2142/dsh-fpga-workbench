import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 每个测试文件独立进程：模块级单例（缓存、注册表）不会互相污染。
    // 代价是启动慢一点；需要共享状态时用 `resetXxx()` 而不是关掉隔离。
    isolate: true,
    // 含子进程的用例可能超过默认 5s。
    testTimeout: 15_000,
    /**
     * 全局 setup（按需启用）。
     *
     * **如果你的插件会写用户目录**（数据台账、缓存），必须在这里把目录指到临时目录 ——
     * 否则每跑一次测试就往用户真实数据里写假记录。见模板里 `tests/setup.example.ts`。
     */
    // setupFiles: ["tests/setup.ts"],
  },
});
