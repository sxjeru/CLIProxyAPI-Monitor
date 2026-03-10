const nextConfig = {
  /* 启用 Next.js 16 实验性视图过渡支持 */
  experimental: {
    viewTransition: true,
  },
  /* 输出 standalone 运行时，配合 Docker 多阶段构建减小镜像体积 */
  output: "standalone",
  /* 生产环境禁用 source maps 以减小镜像大小 */
  productionBrowserSourceMaps: false,
};

export default nextConfig;
