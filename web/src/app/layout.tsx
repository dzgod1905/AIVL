import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Workflow Builder + Multi-Agent",
  description: "PoC: build and run multi-step AI/automation workflows",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <a href="/" className="brand">Workflow PoC</a>
          <nav>
            <a href="/builder">Builder</a>
          </nav>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
