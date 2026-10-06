import React from "react";
import { createRoot } from "react-dom/client";
import { LocalMeetingWorkspace } from "./LocalMeetingWorkspace.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <LocalMeetingWorkspace />
  </React.StrictMode>,
);
