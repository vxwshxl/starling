"""The offline knowledge base.

Starling answers from these passages and nothing else. There is no network
call at answer time and no open-ended generation from the model's own memory:
`llm.py` is instructed to answer only from what retrieval hands it, and to say
so when the passages do not cover the question.

That constraint is the point. This is aimed at healthcare, governance,
education and rural development in places where the alternative is no
information at all, so a confident wrong answer is worse than "I don't know".

Editing rules, if you extend this:

- Keep it general and procedural. Do not state scheme amounts, eligibility
  cut-offs or deadlines -- those change, and a stale number read aloud with
  authority is the failure mode this file exists to avoid.
- Health passages describe recognition and first response, then say who to
  see. They never diagnose and never name a prescription-only drug.
- Write plainly. Everything here may be spoken aloud by a synthetic voice to
  someone who cannot read it back.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Passage:
    id: str
    sector: str
    title: str
    text: str
    #: Extra retrieval terms: colloquial words, symptoms, scheme nicknames.
    #: Retrieval is lexical, so a passage is only findable by the words a
    #: person would actually use.
    tags: tuple[str, ...] = field(default_factory=tuple)


SECTORS = ("healthcare", "governance", "education", "rural development")

PASSAGES: list[Passage] = [
    # ---------------------------------------------------------------- health
    Passage(
        id="health.diarrhoea",
        sector="healthcare",
        title="Diarrhoea and dehydration",
        text=(
            "Loose stools cause the body to lose water and salt, and that loss "
            "is what becomes dangerous, especially in children. Give oral "
            "rehydration solution after every loose stool, and keep giving "
            "normal food and breastmilk. ORS packets are free at government "
            "health centres and ASHA workers carry them. Go to a health centre "
            "the same day if there is blood in the stool, repeated vomiting, "
            "sunken eyes, no urine for many hours, or if the person is very "
            "drowsy."
        ),
        tags=("loose motion", "dehydration", "ORS", "stomach", "child", "vomiting"),
    ),
    Passage(
        id="health.fever",
        sector="healthcare",
        title="Fever",
        text=(
            "Most fevers settle on their own. Give plenty of fluids and rest, "
            "and keep the person cool. In this region fever with chills can be "
            "malaria and fever with body ache and rash can be dengue, so a "
            "fever lasting more than two days should be tested at a health "
            "centre rather than treated at home. Seek help immediately for "
            "fever with neck stiffness, fits, difficulty breathing, or "
            "confusion, and for any fever in a baby under three months."
        ),
        tags=("temperature", "malaria", "dengue", "chills", "hot", "jor"),
    ),
    Passage(
        id="health.maternal",
        sector="healthcare",
        title="Pregnancy care",
        text=(
            "A pregnant woman should register at the nearest health centre or "
            "with an ASHA worker early, and attend at least four antenatal "
            "check-ups. These cover weight, blood pressure, blood tests and "
            "iron and folic acid tablets. Government hospitals provide free "
            "delivery care and there is cash assistance for institutional "
            "delivery. Go immediately for bleeding, severe headache, blurred "
            "vision, severe swelling, or reduced movement of the baby."
        ),
        tags=("pregnant", "antenatal", "ASHA", "delivery", "baby", "mother"),
    ),
    Passage(
        id="health.immunisation",
        sector="healthcare",
        title="Childhood immunisation",
        text=(
            "Routine childhood vaccines are free at government health centres "
            "and at village immunisation sessions. They protect against "
            "tuberculosis, polio, measles, diphtheria, tetanus and hepatitis, "
            "among others. Keep the immunisation card safe and bring it every "
            "visit. If a dose has been missed the schedule can be resumed -- "
            "it does not have to start again. Mild fever or swelling at the "
            "injection site for a day or two is expected."
        ),
        tags=("vaccine", "injection", "polio", "measles", "child", "card"),
    ),
    Passage(
        id="health.tb",
        sector="healthcare",
        title="Persistent cough and tuberculosis",
        text=(
            "A cough lasting more than two weeks, especially with evening "
            "fever, weight loss, night sweats or blood in the sputum, should "
            "be tested for tuberculosis. Testing and treatment are free at "
            "government health facilities. Tuberculosis is curable, but the "
            "medicines must be taken for the full course even after the person "
            "feels better, or the illness can return in a harder-to-treat form."
        ),
        tags=("cough", "TB", "sputum", "weight loss", "night sweat", "chest"),
    ),
    Passage(
        id="health.snakebite",
        sector="healthcare",
        title="Snakebite",
        text=(
            "Snakebite is a medical emergency and needs a hospital with "
            "antivenom, not a local remedy. Keep the person calm and still, "
            "keep the bitten limb below heart level, and remove rings or "
            "bangles before swelling starts. Do not cut the wound, do not "
            "suck out venom, and do not apply a tight tourniquet. Reach the "
            "nearest hospital as fast as possible and, if it can be done "
            "safely, note what the snake looked like."
        ),
        tags=("snake", "bite", "emergency", "antivenom", "poison"),
    ),
    # ------------------------------------------------------------ governance
    Passage(
        id="gov.aadhaar",
        sector="governance",
        title="Aadhaar enrolment and correction",
        text=(
            "Aadhaar enrolment is free at an authorised enrolment centre, "
            "usually in a government office, post office or bank. Bring proof "
            "of identity and address; where documents are missing, a family "
            "head or an authorised introducer can vouch. Keep the enrolment "
            "slip, as it carries the number needed to track the application. "
            "Updating a name, address or mobile number is done at the same "
            "centres and a small fee applies to updates."
        ),
        tags=("aadhaar", "identity card", "enrolment", "update", "address"),
    ),
    Passage(
        id="gov.ration",
        sector="governance",
        title="Ration card and subsidised food grain",
        text=(
            "A ration card lets a household buy subsidised food grain from a "
            "fair price shop. Apply through the state food and civil supplies "
            "department, at a common service centre, or online where the state "
            "offers it, with proof of identity, address and household members. "
            "Ration cards can be used in another state under national "
            "portability, which matters for migrant workers. Report a fair "
            "price shop that refuses to supply or overcharges to the district "
            "supply officer."
        ),
        tags=("ration", "PDS", "food grain", "fair price shop", "BPL", "rice"),
    ),
    Passage(
        id="gov.mgnrega",
        sector="governance",
        title="MGNREGA work and job cards",
        text=(
            "Every rural household is entitled to apply for a job card, which "
            "gives access to guaranteed days of unskilled wage work in a "
            "financial year. Apply at the gram panchayat; the job card itself "
            "is free. Work should be provided within fifteen days of a written "
            "demand, and if it is not, an unemployment allowance is due. Wages "
            "are paid into a bank or post office account. Keep a copy of the "
            "work demand receipt, as it is the proof that a demand was made."
        ),
        tags=("MGNREGA", "job card", "wage", "panchayat", "employment", "100 days"),
    ),
    Passage(
        id="gov.grievance",
        sector="governance",
        title="Making a complaint about a public service",
        text=(
            "If a public office does not act, complaints escalate in steps: "
            "first the office itself, then the block or district officer, then "
            "the state department. Ask for an acknowledgement with a date and "
            "reference number at every stage, since that is what makes an "
            "escalation possible. A Right to Information request can be filed "
            "for a small fee to ask what has happened to an application. Many "
            "states also run a public grievance portal and a helpline number."
        ),
        tags=("complaint", "grievance", "RTI", "officer", "corruption", "appeal"),
    ),
    Passage(
        id="gov.pension",
        sector="governance",
        title="Social pensions",
        text=(
            "Old age, widow and disability pensions are paid monthly through "
            "state social welfare departments. Apply at the panchayat or block "
            "office with proof of age or status, a bank account and Aadhaar. "
            "Payments go directly into the bank account, so the account must "
            "stay active and linked. If a payment stops, check first whether "
            "the account is dormant or the linkage has lapsed before assuming "
            "the pension itself has been cancelled."
        ),
        tags=("pension", "old age", "widow", "disability", "monthly", "bank"),
    ),
    # ------------------------------------------------------------- education
    Passage(
        id="edu.rte",
        sector="education",
        title="Free schooling and admission",
        text=(
            "Children between six and fourteen are entitled to free and "
            "compulsory education in a neighbourhood school. A school cannot "
            "refuse admission for lack of a birth certificate or a transfer "
            "certificate, and cannot hold a child back or expel them before "
            "completing elementary education. A child who has never been "
            "enrolled, or who dropped out, can be admitted to an age-"
            "appropriate class with additional support to catch up."
        ),
        tags=("school", "admission", "RTE", "free education", "dropout", "child"),
    ),
    Passage(
        id="edu.midday",
        sector="education",
        title="Mid-day meals",
        text=(
            "Government and government-aided schools provide a cooked mid-day "
            "meal to enrolled children at no cost, intended to meet a set "
            "share of daily energy and protein needs. If meals are not served, "
            "are irregular, or the food quality is poor, raise it with the "
            "school management committee first and then the block education "
            "officer. Parents are entitled to sit on the school management "
            "committee."
        ),
        tags=("mid day meal", "food", "school", "lunch", "nutrition"),
    ),
    Passage(
        id="edu.scholarship",
        sector="education",
        title="Scholarships",
        text=(
            "Pre-matric and post-matric scholarships exist for scheduled "
            "tribe, scheduled caste, other backward class and minority "
            "students, and separately for girls and for students with "
            "disabilities. Most are applied for online through a national or "
            "state scholarship portal, and applications usually open at the "
            "start of the academic year. Keep the caste or income certificate, "
            "bank passbook and last mark sheet ready, as these are asked for "
            "nearly every time."
        ),
        tags=("scholarship", "student", "college", "ST", "SC", "fees", "stipend"),
    ),
    Passage(
        id="edu.anganwadi",
        sector="education",
        title="Anganwadi services for young children",
        text=(
            "An anganwadi centre serves children under six, pregnant women and "
            "nursing mothers in the village. It provides supplementary "
            "nutrition, pre-school activities, growth monitoring, "
            "immunisation support and health referrals. Enrolment is free and "
            "is done with the anganwadi worker. Growth monitoring is the part "
            "most worth attending, because it catches undernutrition early, "
            "when it is still easy to reverse."
        ),
        tags=("anganwadi", "ICDS", "nutrition", "toddler", "pre school", "mother"),
    ),
    # ------------------------------------------------------- rural development
    Passage(
        id="rural.pmkisan",
        sector="rural development",
        title="Income support for farmers",
        text=(
            "Landholding farmer families can receive direct income support "
            "paid in instalments into a bank account. Registration is done "
            "through the village revenue officer, a common service centre or "
            "the scheme portal, and needs land records, Aadhaar and bank "
            "details. Payments fail most often because the name on the bank "
            "account does not match Aadhaar, or because the land record has "
            "not been updated after inheritance."
        ),
        tags=("PM kisan", "farmer", "income support", "land", "instalment"),
    ),
    Passage(
        id="rural.soil",
        sector="rural development",
        title="Soil testing and fertiliser",
        text=(
            "Soil testing through a government soil health programme reports "
            "what the field actually lacks and recommends fertiliser "
            "accordingly. It is worth doing because applying more fertiliser "
            "than the soil needs costs money, damages soil over time and does "
            "not raise yield. Samples are collected with the help of the "
            "agriculture extension officer, usually after harvest and before "
            "the next sowing."
        ),
        tags=("soil", "fertiliser", "urea", "crop", "yield", "farming", "field"),
    ),
    Passage(
        id="rural.livestock",
        sector="rural development",
        title="Livestock health",
        text=(
            "Government veterinary centres provide vaccination, deworming and "
            "treatment for cattle, pigs, goats and poultry, often at low cost, "
            "and many districts run mobile veterinary services. Vaccinate "
            "before the season when disease usually spreads rather than after "
            "animals fall ill. Separate a sick animal from the herd early, and "
            "report sudden deaths of several animals to the veterinary officer, "
            "since that can signal an outbreak."
        ),
        tags=("cattle", "pig", "goat", "poultry", "vet", "animal", "vaccine"),
    ),
    Passage(
        id="rural.water",
        sector="rural development",
        title="Safe drinking water",
        text=(
            "Water that looks clean can still carry disease. Where a piped or "
            "tested source is not available, boiling water for one minute at a "
            "rolling boil makes it safe to drink, and chlorine tablets from the "
            "health centre are an alternative. Keep stored water covered and "
            "take it out with a ladle rather than dipping hands or cups. In "
            "parts of this region groundwater carries arsenic or excess iron, "
            "which boiling does not remove -- that needs the source tested and "
            "treated."
        ),
        tags=("water", "drinking", "boil", "tube well", "arsenic", "iron", "clean"),
    ),
    Passage(
        id="rural.selfhelp",
        sector="rural development",
        title="Self-help groups and small credit",
        text=(
            "A self-help group is a small savings group, usually of women, "
            "that pools regular savings and lends within the group. Once a "
            "group has a steady savings record it can be linked to a bank for "
            "larger credit at far lower cost than a private moneylender. "
            "Groups are formed with help from the rural livelihood mission or "
            "an NGO. Keeping a clear written record of savings and repayment "
            "is what makes bank linkage possible later."
        ),
        tags=("SHG", "self help group", "loan", "savings", "women", "bank", "credit"),
    ),
]


def by_sector(sector: str) -> list[Passage]:
    return [p for p in PASSAGES if p.sector == sector]


def get(passage_id: str) -> Passage:
    for p in PASSAGES:
        if p.id == passage_id:
            return p
    raise KeyError(passage_id)
