// Deliberately just this. The shell (name, sign-out, nav) lives in
// layout.tsx; the upload view that belongs here is a later step.
export default function DashboardPage() {
  return (
    <p className="text-body-large text-on-surface-variant">
      Upload a file of customer reviews to get started.
    </p>
  );
}
