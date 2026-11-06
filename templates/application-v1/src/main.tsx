import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

// 路径和版本由平台构建固定，业务代码不能向管理API借用平台身份。
const base = import.meta.env.BASE_URL;
/** 默认报名页示例：向平台数据接口提交声明字段，并用构建时版本号防止旧页面误写。Agent 可按需求修改此组件。 */
function App() {
  const [started, setStarted] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main>
      <p className="eyebrow">一起参与 · 一起创造</p>
      <h1>活动报名</h1>
      <p>留下联系方式，我们将向你发送活动安排。</p>
      <form
        onChange={() => { if (!started) { setStarted(true); (window as any).harbor?.track("signup_started"); } }}
        onSubmit={async (event) => {
          event.preventDefault();
          (window as any).harbor?.track("signup_submit_attempted");
          setBusy(true);
          setMessage("");
          const data = new FormData(event.currentTarget);
          try {
            const response = await fetch(base + "api/signup", {
              method: "POST",
              credentials: "same-origin",
              headers: {
                "Content-Type": "application/json",
                "X-App-Revision": __APP_REVISION__,
              },
              body: JSON.stringify({
                name: data.get("name"),
                email: data.get("email"),
              }),
            });
            if (!response.ok)
              throw new Error(
                response.status === 409
                  ? "版本已更新，请刷新后核对报名结果。"
                  : response.status === 401
                    ? "请先登录，再提交报名。"
                    : "提交失败，请稍后再试。",
              );
            setMessage("报名成功，感谢参与！");
          } catch (error) {
            setMessage(
              error instanceof Error
                ? error.message
                : "网络异常，请先核对结果再重试。",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          姓名
          <input name="name" required maxLength={80} autoComplete="name" />
        </label>
        <label>
          邮箱
          <input
            name="email"
            required
            type="email"
            maxLength={160}
            autoComplete="email"
          />
        </label>
        <button disabled={busy}>{busy ? "正在提交…" : "提交报名"}</button>
        <p role="status">{message}</p>
      </form>
      <footer>本页面由 Agent Harbor 创建</footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
