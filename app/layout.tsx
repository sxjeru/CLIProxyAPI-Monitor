import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import Sidebar from "./components/Sidebar";
import ClientLayout from "./components/ClientLayout";

export const metadata: Metadata = {
  title: "CLIProxyAPI Usage Dashboard",
  description: "Usage analytics and cost tracking for CLIProxy API"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100">
        <ClientLayout>{children}</ClientLayout>
        <Analytics />
      </body>
    </html>
  );
}
