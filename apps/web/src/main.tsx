import React from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import { theme } from "./app/theme.js";
import { ThemeController } from "./app/theme-mode.js";
import { createBrowserRouter, RouterProvider } from "react-router";
import { App } from "./app/App.js";
import "./app/styles.css";

// 工作台外壳不随子页面卸载，浏览器历史由成熟路由库处理。
const router = createBrowserRouter([{ path: "*", element: <App /> }]);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ChakraProvider theme={theme}>
      <ThemeController />
      <RouterProvider router={router} />
    </ChakraProvider>
  </React.StrictMode>,
);
