/**
 * Search Console names a country in ISO 3166-1 alpha-3 and Analytics in
 * alpha-2, so one of them has to be translated for a country to mean the same
 * thing in both answers. Alpha-2 is the shared coordinate because Analytics
 * already speaks it and because the platform can turn it into a name, while
 * nothing the runtime offers understands alpha-3 at all.
 *
 * Getting a crossing wrong is silent rather than loud: Search Console answers
 * an alpha-2 filter with an empty result and no error, so a code that failed to
 * translate would read as a country nobody visited from.
 *
 * The table is CLDR's `codeMappings` — the current territories, one alpha-3
 * each, which is the data ICU itself is built from. The codes ISO sets aside
 * for private use are kept rather than filtered as noise, because real search
 * data contains them: `zzz` is the region Google could not determine, and `xkk`
 * is Kosovo, which ISO has assigned no code of its own. CLDR gives the European
 * Union and its deprecated alias the same alpha-3, which is the one entry that
 * had to be resolved rather than copied.
 */
const TABLE = `
AAA=AA ABW=AW AFG=AF AGO=AO AIA=AI ALA=AX ALB=AL AND=AD ANT=AN ARE=AE
ARG=AR ARM=AM ASC=AC ASM=AS ATA=AQ ATF=TF ATG=AG AUS=AU AUT=AT AZE=AZ
BDI=BI BEL=BE BEN=BJ BES=BQ BFA=BF BGD=BD BGR=BG BHR=BH BHS=BS BIH=BA
BLM=BL BLR=BY BLZ=BZ BMU=BM BOL=BO BRA=BR BRB=BB BRN=BN BTN=BT BUR=BU
BVT=BV BWA=BW CAF=CF CAN=CA CCK=CC CHE=CH CHL=CL CHN=CN CIV=CI CMR=CM
COD=CD COG=CG COK=CK COL=CO COM=KM CPT=CP CPV=CV CRI=CR CUB=CU CUW=CW
CXR=CX CYM=KY CYP=CY CZE=CZ DDR=DD DEU=DE DGA=DG DJI=DJ DMA=DM DNK=DK
DOM=DO DZA=DZ ECU=EC EGY=EG ERI=ER ESH=EH ESP=ES EST=EE ETH=ET FIN=FI
FJI=FJ FLK=FK FRA=FR FRO=FO FSM=FM FXX=FX GAB=GA GBR=GB GEO=GE GGY=GG
GHA=GH GIB=GI GIN=GN GLP=GP GMB=GM GNB=GW GNQ=GQ GRC=GR GRD=GD GRL=GL
GTM=GT GUF=GF GUM=GU GUY=GY HKG=HK HMD=HM HND=HN HRV=HR HTI=HT HUN=HU
IDN=ID IMN=IM IND=IN IOT=IO IRL=IE IRN=IR IRQ=IQ ISL=IS ISR=IL ITA=IT
JAM=JM JEY=JE JOR=JO JPN=JP KAZ=KZ KEN=KE KGZ=KG KHM=KH KIR=KI KNA=KN
KOR=KR KWT=KW LAO=LA LBN=LB LBR=LR LBY=LY LCA=LC LIE=LI LKA=LK LSO=LS
LTU=LT LUX=LU LVA=LV MAC=MO MAF=MF MAR=MA MCO=MC MDA=MD MDG=MG MDV=MV
MEX=MX MHL=MH MKD=MK MLI=ML MLT=MT MMR=MM MNE=ME MNG=MN MNP=MP MOZ=MZ
MRT=MR MSR=MS MTQ=MQ MUS=MU MWI=MW MYS=MY MYT=YT NAM=NA NCL=NC NER=NE
NFK=NF NGA=NG NIC=NI NIU=NU NLD=NL NOR=NO NPL=NP NRU=NR NTZ=NT NZL=NZ
OMN=OM PAK=PK PAN=PA PCN=PN PER=PE PHL=PH PLW=PW PNG=PG POL=PL PRI=PR
PRK=KP PRT=PT PRY=PY PSE=PS PYF=PF QAT=QA QMM=QM QNN=QN QOO=QO QPP=QP
QQQ=QQ QRR=QR QSS=QS QTT=QT QUU=EU QVV=QV QWW=QW QXX=QX QYY=QY QZZ=QZ
REU=RE ROU=RO RUS=RU RWA=RW SAU=SA SCG=CS SDN=SD SEN=SN SGP=SG SGS=GS
SHN=SH SJM=SJ SLB=SB SLE=SL SLV=SV SMR=SM SOM=SO SPM=PM SRB=RS SSD=SS
STP=ST SUN=SU SUR=SR SVK=SK SVN=SI SWE=SE SWZ=SZ SXM=SX SYC=SC SYR=SY
TAA=TA TCA=TC TCD=TD TGO=TG THA=TH TJK=TJ TKL=TK TKM=TM TLS=TL TMP=TP
TON=TO TTO=TT TUN=TN TUR=TR TUV=TV TWN=TW TZA=TZ UGA=UG UKR=UA UMI=UM
URY=UY USA=US UZB=UZ VAT=VA VCT=VC VEN=VE VGB=VG VIR=VI VNM=VN VUT=VU
WLF=WF WSM=WS XAA=XA XBB=XB XCC=XC XDD=XD XEE=XE XFF=XF XGG=XG XHH=XH
XII=XI XJJ=XJ XKK=XK XLL=XL XMM=XM XNN=XN XOO=XO XPP=XP XQQ=XQ XRR=XR
XSS=XS XTT=XT XUU=XU XVV=XV XWW=XW XXX=XX XYY=XY XZZ=XZ YEM=YE YMD=YD
YUG=YU ZAF=ZA ZAR=ZR ZMB=ZM ZWE=ZW ZZZ=ZZ
`;

const crossings = TABLE.trim()
  .split(/\s+/)
  .map((pair) => pair.split("=") as [string, string]);

const TO_ALPHA_2 = new Map(crossings);
const TO_ALPHA_3 = new Map(crossings.map(([three, two]) => [two, three]));

/**
 * A country the table has never heard of still had visitors, so its code is
 * repeated as it arrived: dropping the row would lose them, and guessing at a
 * neighbouring code would file them under someone else.
 */
export const alpha2 = (code: string) => {
  const upper = code.toUpperCase();
  return TO_ALPHA_2.get(upper) ?? upper;
};

/** Refused rather than passed through, because Search Console would say nothing. */
export const alpha3 = (code: string) => {
  const upper = code.toUpperCase();
  const found = TO_ALPHA_3.get(upper);

  if (!found) {
    throw new Error(
      `${upper} is not a country code Search Console can be asked about`,
    );
  }

  return found;
};
