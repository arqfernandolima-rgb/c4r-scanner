import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { TooltipProvider } from '@/components/ui/tooltip';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Revit C4R Scanner',
  description: 'Identify and upgrade deprecated Collaboration for Revit files across your ACC/BIM360 hub',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? '?';
  const sha = process.env.NEXT_PUBLIC_BUILD_SHA ?? 'dev';

  return (
    <html lang="en">
      <body className={`${inter.className} bg-background text-foreground antialiased`}>
        <TooltipProvider>
          {children}
        </TooltipProvider>
        <div className="fixed top-2 right-3 text-[10px] text-muted-foreground/40 tabular-nums select-none pointer-events-none z-50">
          v{version} · {sha}
        </div>
      </body>
    </html>
  );
}
