import { ACCEPTED_MIME_TYPES, MAX_UPLOAD_SIZE_BYTES } from "@/lib/ai/config";
import UploadForm from "@/components/UploadForm";

// A server component: it reads config (safe here, server-side only) and
// hands the two display-relevant values down as props. lib/ai/config.ts
// also holds DEEPSEEK_API_KEY - it's never imported by UploadForm itself,
// a client component, even though these two values aren't secret.
export default function UploadPage() {
  return (
    <div className="flex flex-col gap-base">
      <h1 className="text-headline-small">Upload reviews</h1>
      <p className="text-body-medium text-on-surface-variant">
        Each file becomes a job. Uploading queues it - processing happens separately.
      </p>
      <UploadForm maxSizeBytes={MAX_UPLOAD_SIZE_BYTES} acceptedTypes={ACCEPTED_MIME_TYPES} />
    </div>
  );
}
