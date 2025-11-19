import Link from "next/link";

// Just a template to fill out the about page for now; the info is incorrect.
export const AboutView = () => {
  return (
    <main className="min-h-screen flex flex-col items-center px-6 py-16 space-y-12">
      <header className="max-w-3xl text-center">
        <h1 className="text-4xl font-bold mb-4">About Speech to Text</h1>
        <p className="text-muted-foreground text-lg">
          Our Speech to Text solution automatically converts spoken audio into
          text, making it easier to transcribe meetings, interviews, and voice
          notes.
        </p>
      </header>

      <section className="max-w-3xl w-full">
        <h2 className="text-2xl font-semibold mb-2">Purpose & Use Cases</h2>
        <p>
          This platform helps users transcribe recordings accurately and store
          them securely. Typical use cases include meeting summaries, research
          interviews, and accessibility tools.
        </p>
      </section>

      <section className="max-w-3xl w-full">
        <h2 className="text-2xl font-semibold mb-2">Technical Details</h2>
        <ul className="list-disc list-inside">
          <li>Supported audio formats: WAV, MP3, and M4A</li>
          <li>Maximum file size: 100 MB</li>
          <li>Storage period: 30 days (auto-deletion)</li>
          <li>Languages supported: Danish, English, and Swedish</li>
        </ul>
        <p className="mt-2">
          For full API documentation, visit{" "}
          <Link
            href="/docs"
            className="text-primary underline underline-offset-2"
          >
            the API docs
          </Link>
          .
        </p>
      </section>

      <section className="max-w-3xl w-full">
        <h2 className="text-2xl font-semibold mb-2">API & Integration</h2>
        <p>
          Developers can integrate Speech to Text through our REST API to enable
          automatic transcription in external applications.
        </p>
      </section>

      <section className="max-w-3xl w-full">
        <h2 className="text-2xl font-semibold mb-2">Support & Contact</h2>
        <p>
          For support inquiries, please contact{" "}
          <a
            href="mailto:support@example.com"
            className="text-primary underline underline-offset-2"
          >
            support@example.com
          </a>
          .
        </p>
      </section>

      <section className="max-w-3xl w-full text-sm text-muted-foreground border-t pt-6">
        <h2 className="text-lg font-semibold mb-1">Legal Information</h2>
        <p>
          All uploaded data is processed according to GDPR regulations. For full
          compliance and privacy information, see{" "}
          <Link
            href="/legal"
            className="text-primary underline underline-offset-2"
          >
            our legal documentation
          </Link>
          .
        </p>
      </section>
    </main>
  );
};
