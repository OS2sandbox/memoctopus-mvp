# Opsætning af Teams-referater

Denne guide er til IT-administratoren i kommunen. Den skal kun følges én gang.

Memoctopus henter ikke længere lyd ved at sende en robot ind i mødet. I stedet beder
appen Microsoft Teams om selv at transskribere mødet, og henter bagefter Teams'
egen transskription (og eventuelt optagelsen) via Microsoft Graph. Det betyder, at
brugerne ikke skal gøre noget nyt i Teams, og at der ikke er en ekstra deltager i
mødet.

Opsætningen består af to trin i Microsoft-portalerne. Regn med 15 minutter, plus op
til en times ventetid på, at Teams-politikken slår igennem.

---

## Trin 1 — Giv appen adgang til møder og kalender

Foretages i **Entra admin center** ([entra.microsoft.com](https://entra.microsoft.com))
af en bruger med rollen *Global administrator* eller *Privileged role administrator*.

1. Gå til **Identity → Applications → App registrations**, og åbn den
   app-registrering, der i dag bruges til Microsoft-login i Memoctopus.
2. Vælg **API permissions → Add a permission → Microsoft Graph → Delegated
   permissions**, og sæt flueben ved:

   | Tilladelse | Hvad den bruges til |
   |---|---|
   | `OnlineMeetings.ReadWrite` | Slå automatisk transskription til på det enkelte møde |
   | `OnlineMeetingTranscript.Read.All` | Hente mødets transskription bagefter |
   | `OnlineMeetingRecording.Read.All` | Hente mødets optagelse bagefter |
   | `User.Read` | Læse brugerens eget navn og e-mail (findes typisk allerede) |
   | `offline_access` | Fornye adgangen, så brugeren ikke skal logge ind igen hver time |

   Det er **delegerede** tilladelser. Appen får aldrig mere adgang, end den
   bruger der er logget ind, selv har — den kan kun se de møder, brugeren selv
   er inviteret til. Der bliver **ikke** bedt om adgang til kalender eller
   postkasse.

3. Tryk **Grant admin consent for \<organisation\>**. Uden dette trin bliver hver
   enkelt bruger mødt af en samtykke-dialog, som de typisk ikke selv har
   rettigheder til at godkende.
4. Kontrollér under **Authentication**, at denne redirect-URI står på listen som
   type *Web*:

   ```
   https://<jeres-referat-adresse>/api/auth/callback/microsoft
   ```

5. Bekræft, at Memoctopus' `MICROSOFT_TENANT_ID` er sat til organisationens
   rigtige tenant-id. Står den tom, bruger appen `common`, og det
   administrator-samtykke I netop gav, får ikke virkning.

## Trin 2 — Tillad optagelse og transskription i Teams

Foretages i **Teams admin center** ([admin.teams.microsoft.com](https://admin.teams.microsoft.com)).

1. Gå til **Meetings → Meeting policies**, og åbn den politik, brugerne er
   omfattet af (typisk **Global (Org-wide default)**).
2. Under **Recording & transcription** skal begge disse stå til **On**:
   - *Transcription*
   - *Meeting recording*
3. Gem. **Ændringen kan være op til en time om at slå igennem.** Indtil da vil
   Memoctopus melde, at mødet ikke kunne forberedes.

Begge indstillinger skal være tilladt af politikken. Ellers accepterer Microsoft
Graph godt nok anmodningen om automatisk transskription, men Teams ignorerer den
i praksis — og Memoctopus viser fejlen *"Jeres Teams-politik tillader ikke
optagelse eller transskription"*.

## Trin 3 — Kontrollér at Graph må læse transskriptioner

Nogle organisationer har slået API-adgang til transskriptioner fra. Findes i
**Teams admin center → Meetings → Meeting settings**, under indstillingerne for
adgang til transskription og optagelse via API.

Er den slået fra, kan Memoctopus ikke hente transskriptionen, og viser fejlen
*"Jeres organisation har slået Graph-adgang til transskriptioner fra"*. Der er
ingen anden vej rundt om det end at slå indstillingen til.

---

## Sådan bruger medarbejderne det bagefter

1. Log ind i Memoctopus med Microsoft. **Brugere, der loggede ind før denne
   opsætning, skal logge ud og ind igen**, så den nye adgang bliver gemt. Indtil
   de gør det, viser forsiden en knap *"Giv adgang igen"*.
2. Planlæg mødet i Outlook eller Teams som altid.
3. Kopiér mødelinket — det samme "Deltag i Teams-møde"-link, som deltagerne får
   i indkaldelsen — og indsæt det i **Mødelink**-feltet i Memoctopus.
4. Hold mødet. **Ingen skal trykke på noget i Teams undervejs**, og der kommer
   ingen ekstra deltager ind i mødet. Memoctopus beder Teams om selv at
   transskribere.
5. Et par minutter efter mødet er referatet klar i Memoctopus.

Møder, man ikke selv er arrangør af, kan Memoctopus ikke slå transskription til på.
Her viser Memoctopus i stedet en sætning, man kan sende til arrangøren.

## Fejlsøgning

| Det brugeren ser | Årsag | Løsning |
|---|---|---|
| "Teams-referater kræver, at du logger ind med Microsoft" | Brugeren er logget ind med e-mail/adgangskode eller en anden udbyder | Log ind med Microsoft |
| Knappen "Giv adgang igen" | Brugeren loggede ind, før tilladelserne i trin 1 blev givet | Log ud og ind igen |
| "Jeres Teams-politik tillader ikke optagelse eller transskription" | Trin 2 mangler, eller er endnu ikke slået igennem | Gennemgå trin 2, vent op til en time |
| "Jeres organisation har slået Graph-adgang til transskriptioner fra" | Indstillingen i trin 3 | Gennemgå trin 3 |
| "Du skal være inviteret til mødet" | Mødet ligger ikke i brugerens kalender — fx et ad hoc "Mød nu", eller et link videresendt fra en anden | Brug et møde, brugeren selv er inviteret til |
| "Mødelinket er ikke et gyldigt Teams-link" | Der er indsat noget andet end et Teams-mødelink | Kopiér linket fra mødeindkaldelsen igen |
| Mødet står i "Venter på Teams" længe efter mødet | Microsoft er nogle gange et stykke tid om at frigive transskriptionen | Tryk **Tjek nu**. Memoctopus prøver selv i op til 24 timer |

Kommer der ingen transskription, kan man kontrollere i
[Graph Explorer](https://developer.microsoft.com/graph/graph-explorer) som den
samme bruger:

```
GET /me/onlineMeetings?$filter=JoinWebUrl eq '<mødelink>'
GET /me/onlineMeetings/<id>/transcripts
```

Ligger transskriptionen der, men ikke i Memoctopus, er det en fejl i Memoctopus.
Ligger den ikke der, kom Teams aldrig i gang med at transskribere — så er det
trin 2 eller 3, der mangler.

## Hvor ligger data?

Teams gemmer selv optagelsen i arrangørens OneDrive og transskriptionen på
mødet, efter organisationens egne opbevaringsregler. Det er Microsofts
standardopførsel og ikke noget Memoctopus styrer.

Memoctopus henter en kopi, laver referatet og gemmer det i kommunens egen
Memoctopus-database. Ønsker man slet ikke optagelser i spil, kan driften sætte
`TEAMS_ARTIFACT_MODE=transcript-only`. Så bruger Memoctopus kun Teams'
tekst-transskription og downloader aldrig lyd.
