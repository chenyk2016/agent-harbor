# 网页客户端

V4页面设计稿在[prototype/index.html](prototype/index.html)，是独立可点击原型，不连接V3服务或真实模型。页面结构与已有HTTP/SSE能力的对应见[设计说明](../../../docs/design/v4-web-client.md)。

在项目根目录预览：

```sh
python3 -m http.server 8434 --bind 127.0.0.1 --directory src/clients/web/prototype
```

打开http://127.0.0.1:8434。原型数据只在当前页面内存，刷新还原示例；右上角可以切换演示状态。正式网页客户端及登录/凭证方案尚未接入。
