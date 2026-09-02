import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RecoverAI — Payment Recovery Console",
  description:
    "Merchant dashboard for intelligent Razorpay payment recovery. Diagnose failures, score recoverability, and get actionable recommendations.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="dashboard-root">{children}</body>
    </html>
  );
}
