import "./styles/globals.css";
import ReactDOM from "react-dom/client";
import { MobileApp } from "./modules/agent/MobileApp";
import { TooltipProvider } from "./components/ui/tooltip";

if (matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.classList.add("dark");
const root = document.getElementById("root");
if (!root) throw new Error("Mobile root is missing");
ReactDOM.createRoot(root).render(<TooltipProvider><MobileApp /></TooltipProvider>);
