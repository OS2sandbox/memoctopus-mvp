interface WizardHeaderProps {
  infoText?: string;
}

const defaultInfoText =
  "Gennemgå hvert trin for at uploade, skrive prompt, godkende og dele.";

export const WizardHeader = ({
  infoText = defaultInfoText,
}: WizardHeaderProps) => (
  <div className="text-center">
    <h2 className="text-2xl font-semibold">Tale til tekst</h2>
    <p className="text-sm text-muted-foreground">{infoText}</p>
  </div>
);
