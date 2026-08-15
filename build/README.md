electron-builder 构建资源目录（图标等实际位于 ../resources/）。
NSIS 安装脚本由 electron-builder 自动生成；如需深度定制可在此放置 .nsh include 并在 package.json 的 build.nsis.include 中引用。
