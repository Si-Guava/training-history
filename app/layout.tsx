import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Training History · Fresh Start",
  description: "Your workout history, progress charts, and saved exercise entries.",
  applicationName: "Training History",
  appleWebApp: {
    capable: true,
    title: "Training",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/icons/app-icon.svg",
    apple: "/icons/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
