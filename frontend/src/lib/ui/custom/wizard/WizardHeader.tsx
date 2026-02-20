interface WizardHeaderProps {
  title?: string;
  infoText?: string;
}

export const WizardHeader = ({
  title = "Tale til tekst",
  infoText = "Gennemgå hvert trin for at uploade, vælge skabelon, godkende og dele.",
}: WizardHeaderProps) => (
  <div className="text-center">
    <h2 className="text-2xl font-semibold">{title}</h2>
    <p className="text-sm text-muted-foreground">{infoText}</p>
  </div>
);
