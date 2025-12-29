import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "./components/Sidebar";

export const metadata: Metadata = {
  title: "CLIProxy Usage Dashboard",
  description: "Usage analytics and cost tracking for CLIProxy API"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100">
        <Sidebar />
        <div className="ml-56 min-h-screen">{children}</div>
      </body>
    </html>
  );
}
