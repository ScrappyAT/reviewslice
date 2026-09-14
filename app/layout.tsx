import type { Metadata } from "next";
import { DM_Sans } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// next/font/google self-hosts the font at build time (no runtime request
// to Google Fonts from the browser) and exposes it as a CSS variable
// rather than a class, because design-tokens.css / globals.css reference
// it as var(--font-dm-sans) - the font has to be a variable on an
// ancestor element, not a className swap, for that reference to resolve.
const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Reviewslice",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={dmSans.variable}>
      <body>{children}</body>
    </html>
  );
}
