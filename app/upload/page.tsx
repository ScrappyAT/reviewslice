// Deliberately just this. The shell (name, sign-out) lives in layout.tsx;
// the actual upload form that belongs here is a later step.
export default function UploadPage() {
  return (
    <p className="text-body-large text-on-surface-variant">
      Upload a file of customer reviews to get started.
    </p>
  );
}
