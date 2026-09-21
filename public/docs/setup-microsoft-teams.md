# Opsætning af Teams-referater

Denne guide er til IT-administratoren i kommunen. Den skal kun følges én gang.

Memoctopus henter ikke længere lyd ved at sende en robot ind i mødet. I stedet beder
appen Microsoft Teams om selv at transskribere mødet, og henter bagefter Teams'
egen transskription (og eventuelt optagelsen) via Microsoft Graph. Brugerne skal derfor ikke gøre
noget nyt i Teams, og der kommer ingen ekstra deltager i mødet.

Opsætningen består af to trin i Microsoft-portalerne. Regn med 15 minutter, plus op
til en times ventetid på, at Teams-politikken slår igennem.

**Teams-referater er slået fra som standard.** Driften slår dem til ved at sætte
`TEAMS_GRAPH_ENABLED=true` i Memoctopus' miljøvariabler og genstarte appen, og det
skal først ske, **når trin 1 er gennemført**. Se rammen under trin 1.

## Trin 1. Giv appen adgang til møderne

Foretages i **Entra admin center** ([entra.microsoft.com](https://entra.microsoft.com))
af en bruger med rollen *Global administrator* eller *Privileged role administrator*.

1. Åbn under **Identity / Applications / App registrations** den app-registrering,
   der i dag bruges til Microsoft-login i Memoctopus.
2. Vælg **API permissions / Add a permission / Microsoft Graph / Delegated
   permissions** og sæt flueben ved:

   | Tilladelse | Hvad den bruges til |
   |---|---|
   | `OnlineMeetings.ReadWrite` | Slå automatisk transskription til på det enkelte møde |
   | `OnlineMeetingTranscript.Read.All` | Hente mødets transskription bagefter |
   | `OnlineMeetingRecording.Read.All` | Hente mødets optagelse bagefter (kan udelades ved `TEAMS_ARTIFACT_MODE=transcript-only`) |
   | `User.Read` | Læse brugerens eget navn og e-mail (findes typisk allerede) |
   | `offline_access` | Fornye adgangen, så brugeren ikke skal logge ind igen hver time |

   Alle tre er **delegerede** tilladelser. Appen får ikke videre adgang end den
   indloggede medarbejder og kan alene se møder med medarbejderen som inviteret.
   Der bliver **ikke** bedt om adgang til kalender eller postkasse.

3. Tryk **Grant admin consent for \<organisation\>**. Uden dette trin bliver hver
   enkelt bruger mødt af en samtykke-dialog, som de typisk ikke selv har
   rettigheder til at godkende.
4. Kontrollér under **Authentication**, at denne redirect-URI står på listen som
   type *Web*:

   ```
   https://<jeres-referat-adresse>/api/auth/callback/microsoft
   ```

5. Bekræft, at Memoctopus' `MICROSOFT_TENANT_ID` er sat til organisationens
   rigtige tenant-id. Står feltet tomt, bruger appen `common`, og så kan brugere
   fra alle tenants logge ind. Administrator-samtykket gælder fortsat i jeres
   tenant, men det gælder kun jeres tenant: samtykke gives **pr. tenant**, og det
   følger ikke med brugere fra andre organisationer.

> **Vigtigt: giv samtykke, før Teams slås til i Memoctopus.** Når driften sætter
> `TEAMS_GRAPH_ENABLED=true`, beder Microsoft-login om de tilladelser, der står
> ovenfor. `OnlineMeetingTranscript.Read.All` og `OnlineMeetingRecording.Read.All`
> kræver administrator-samtykke. Har tenanten ikke givet det, svarer Microsoft
> *"Need admin approval"* på selve login-forsøget, og **ingen** kan så logge ind med
> Microsoft, heller ikke til andet end Teams. Er tenantens arbejdsgang til
> samtykke-anmodninger slået fra, kan brugerne heller ikke bede om det.
> Indstillingen læses ved opstart, så appen skal genstartes efter en ændring.
> Med `TEAMS_ARTIFACT_MODE=transcript-only` bliver optagelses-tilladelsen slet
> ikke bedt om.

## Trin 2. Tillad optagelse og transskription i Teams

Foretages i **Teams admin center** ([admin.teams.microsoft.com](https://admin.teams.microsoft.com)).

1. Gå til **Meetings / Meeting policies** og åbn brugernes mødepolitik
   (typisk **Global (Org-wide default)**).
2. Under **Recording & transcription** skal begge disse stå til **On**:
   - *Transcription*
   - *Meeting recording*
3. Gem. **Ændringen kan være op til en time om at slå igennem.** Indtil da vil
   Memoctopus melde, at mødet ikke kunne forberedes.

Begge indstillinger skal være tilladt af politikken. Ellers accepterer Microsoft
Graph godt nok anmodningen om automatisk transskription, men Teams ignorerer den
i praksis. Memoctopus viser i det tilfælde fejlen *"Jeres Teams-politik tillader
ikke optagelse eller transskription"*.

## Trin 3. Kontrollér at Graph må læse transskriptioner

Nogle organisationer har slået API-adgang til transskriptioner fra. Findes i
**Teams admin center / Meetings / Meeting settings** under indstillingerne for
adgang til transskription og optagelse via API.

Er den slået fra, kan Memoctopus ikke hente transskriptionen, og viser fejlen
*"Jeres organisation har slået Graph-adgang til transskriptioner fra"*. Der er
ingen anden vej rundt om det end at slå indstillingen til.

---

## Sådan bruger medarbejderne det bagefter

1. Log ind i Memoctopus med Microsoft. **Brugere, der loggede ind, før Teams blev
   slået til, skal logge ud og ind igen**, så den nye adgang bliver gemt. Indtil
   de gør det, viser forsiden en knap *"Giv adgang igen"*.
2. Planlæg mødet i Outlook eller Teams som altid.
3. Kopiér mødelinket, altså det samme "Deltag i Teams-møde"-link som deltagerne
   får i indkaldelsen, og indsæt det i **Mødelink**-feltet i Memoctopus. Linket kan
   kopieres både fra mødeindkaldelsen i Outlook og med "Kopiér link til deltagelse"
   i Teams. Har organisationen Defender Safe Links slået til, bliver links i mails
   skrevet om til en `safelinks.protection.outlook.com`-adresse. Det er i orden,
   fordi Memoctopus selv finder det rigtige mødelink inde i den.
4. Hold mødet. **Ingen skal trykke på noget i Teams undervejs**, og der kommer
   ingen ekstra deltager ind i mødet. Memoctopus beder Teams om selv at
   transskribere.
5. Et par minutter efter mødet er referatet klar i Memoctopus.

Memoctopus kan ikke slå transskription til på møder med en anden arrangør. I de
tilfælde vises en sætning, der kan sendes videre til arrangøren.

## Fejlsøgning

| Det brugeren ser | Årsag | Løsning |
|---|---|---|
| "Teams-referater kræver, at du logger ind med Microsoft" | Brugeren er logget ind med e-mail/adgangskode eller en anden udbyder | Log ind med Microsoft |
| Ingen mulighed for at indsætte et mødelink, eller "Teams-integrationen er ikke slået til" | `TEAMS_GRAPH_ENABLED` er ikke sat til `true`, eller appen er ikke genstartet efter ændringen | Sæt den, når trin 1 er gennemført, og genstart |
| Microsoft-login svarer "Need admin approval" | `TEAMS_GRAPH_ENABLED=true`, men administrator-samtykket i trin 1 er ikke givet i brugerens tenant | Giv samtykket, eller sæt `TEAMS_GRAPH_ENABLED` tilbage og genstart |
| Knappen "Giv adgang igen" | Brugeren loggede ind, før tilladelserne i trin 1 blev givet | Log ud og ind igen |
| "Jeres Teams-politik tillader ikke optagelse eller transskription" | Trin 2 mangler, eller er endnu ikke slået igennem | Gennemgå trin 2, vent op til en time |
| "Jeres organisation har slået Graph-adgang til transskriptioner fra" | Indstillingen i trin 3 | Gennemgå trin 3 |
| "Du skal være inviteret til mødet" | Mødet ligger ikke i brugerens kalender — fx et ad hoc "Mød nu", eller et link videresendt fra en anden | Brug et møde, brugeren selv er inviteret til |
| "Mødelinket er ikke et gyldigt Teams-link" | Der er indsat noget andet end et Teams-mødelink | Kopiér linket fra mødeindkaldelsen igen |
| Mødet står i "Venter på Teams" længe efter mødet | Microsoft er nogle gange et stykke tid om at frigive transskriptionen | Tryk **Tjek nu**. Memoctopus prøver selv i op til 24 timer |

Kommer der ingen transskription, kan forholdet kontrolleres i
[Graph Explorer](https://developer.microsoft.com/graph/graph-explorer) som den
samme bruger:

```
GET /me/onlineMeetings?$filter=JoinWebUrl eq '<mødelink>'
GET /me/onlineMeetings/<id>/transcripts
```

Ligger transskriptionen der, men ikke i Memoctopus, er det en fejl i Memoctopus.
Ligger den ikke der, kom Teams aldrig i gang med at transskribere, og så mangler
trin 2 eller trin 3.

## Hvor ligger data?

Teams gemmer selv optagelsen i arrangørens OneDrive og transskriptionen på
mødet, efter organisationens egne opbevaringsregler. Det er Microsofts
standardopførsel og ikke noget Memoctopus styrer.

Memoctopus henter en kopi, transskriberer den og sletter derefter lyden. Selve
lydoptagelsen bliver aldrig gemt i Memoctopus og bliver aldrig sendt til
medarbejderens browser. Memoctopus gemmer transskriptionen og referatet
i kommunens egen database.

Baggrunden er, at Teams først frigiver optagelsen efter mødet. Et Teams-møde kan
derfor ikke følges live i Memoctopus, og så er der heller ingen grund til at
opbevare lyden bagefter.

Ønsker kommunen, at Memoctopus slet ikke downloader lyd, kan driften sætte
`TEAMS_ARTIFACT_MODE=transcript-only`. Så bruges alene Teams' egen
tekst-transskription. Referatkvaliteten bliver typisk lidt lavere, fordi
Memoctopus ellers transskriberer med sin egen danske model.
