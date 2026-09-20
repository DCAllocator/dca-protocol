import { DisclaimerGate } from "@/components/Disclaimer";
import { AppShell } from "@/components/app/AppShell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <DisclaimerGate>
      <AppShell>{children}</AppShell>
    </DisclaimerGate>
  );
}
