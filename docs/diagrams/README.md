# 架构图源文件

README 使用此目录的高清 PNG，SVG 是可编辑源文件。三张图分别说明系统边界、采集发布顺序、数据流转与版本一致性，内容以当前代码和工作流为准。

修改 SVG 后，从仓库根目录重新导出：

```sh
npx tsx docs/diagrams/render.ts
```

导出使用项目已有的 Playwright，以 2 倍分辨率生成 PNG，并检查文字是否超出画布。需要已安装 Chromium，或通过 `STATUSGRID_BROWSER_EXECUTABLE` 指定浏览器。中文字体优先使用苹方，其次使用微软雅黑；其他系统需提供可用的中文字体。修改后检查图片中的中文、连线与标注，再一起提交 SVG 和 PNG。
