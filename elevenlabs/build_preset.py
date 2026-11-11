"""Embed tonight's researched table into the artifact page.

Reads research/*.md, cuts one dossier per candidate, and writes them into
artifact/index.html between the RESEARCH markers. Re-run after the research is refreshed.
"""
import json, re, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
research = root / 'research'

def sections(path):
    """Map each '## ' heading to its text, without the sources list."""
    out, title, buf = {}, None, []
    for line in path.read_text().splitlines():
        if line.startswith('## '):
            if title: out[title] = '\n'.join(buf).strip().rstrip('-').strip()
            title, buf = line[3:].strip(), []
        elif title:
            buf.append(line)
    if title: out[title] = '\n'.join(buf).strip()
    return out

candidates = {}
for name in ('droite-nationale.md', 'droite-centre.md', 'gauche.md'):
    path = research / name
    if not path.exists(): continue
    for title, text in sections(path).items():
        m = re.match(r'\d+\.\s*(.+?)\s*\((.+)\)\s*$', title)
        if m: candidates[m.group(1)] = text

ctx = sections(research / 'contexte.md')
pick = lambda n: next((f'{t}\n{v}' for t, v in ctx.items() if t.startswith(f'{n}.')), '')
situation = '\n\n'.join(pick(n) for n in (1, 2, 4))
questions = pick(5)
hard = '\n\n'.join(
    f'{name} :\n' + text[text.find('**QUESTIONS DIFFICILES'):text.find('**STYLE')].strip()
    for name, text in candidates.items() if '**QUESTIONS DIFFICILES' in text)

# (surname to find in the research, party, voice, one-line register)
TABLE = [
    ('Marine Le Pen', 'Rassemblement national', 'Celine'),
    ('Jean-Luc Mélenchon', 'La France insoumise', 'Florian'),
    ('Raphaël Glucksmann', 'Place publique, soutenu par le PS', 'Timothee'),
    ('Édouard Philippe', 'Horizons', 'Jonathan'),
    ('Bruno Retailleau', 'Les Républicains', 'Christophe'),
    ('Gabriel Attal', 'Renaissance', 'Thomas'),
    ('David Lisnard', 'Nouvelle Énergie', 'Guillaume'),
    ('Éric Zemmour', 'Reconquête', 'Anthony'),
]
def deep(name):
    """Second-pass dossier (programme, record, court cases, controversies), if it has been researched."""
    slug = name.split()[-1].lower().replace('é', 'e')
    slug = 'le-pen' if slug == 'pen' else slug
    path = research / f'approfondi-{slug}.md'
    if not path.exists(): return ''
    text = path.read_text()
    cut = text.find('\n## Sources')
    return '\n\nDOSSIER APPROFONDI : programme, parti, prises de parole, bilan, affaires et controverses\n' + (text[:cut] if cut > 0 else text).strip()

seats = []
for name, party, voice in TABLE:
    dossier = candidates.get(name)
    if dossier: dossier += deep(name)
    seats.append({
        'name': f'Voix de {name}', 'role': party, 'voice': voice, 'kind': 'candidate',
        'persona': f"Voix d'intelligence artificielle qui présente les positions publiques documentées de {name}, à la troisième personne, sans jamais prétendre être {name.split()[0]} {' '.join(name.split()[1:])} et sans inventer de citation. Défend le projet avec conviction ; dit clairement quand le candidat n'a pas donné de réponse publique.",
        'dossier': f'{dossier}\n\nCONTEXTE NATIONAL\n{situation}' if dossier else None,
    })
for name, beat, voice in [
    ('Claire Morel', 'Intervieweuse, économie et finances publiques', 'Claire'),
    ('Cécile Garnier', 'Intervieweuse, institutions, sécurité, immigration et justice', 'Cecile'),
    ('Inès Benali', 'Intervieweuse, Europe, international et climat', 'Jade'),
]:
    seats.append({
        'name': name, 'role': beat, 'voice': voice, 'kind': 'interviewer',
        'persona': "Journaliste spécialisée. Pose les questions précises et difficiles, celles auxquelles les candidats devraient répondre et qu'ils évitent. S'appuie sur des faits et des chiffres sourcés, relance une fois quand la réponse esquive, et traite chaque candidature avec la même exigence.",
        'dossier': f'CONTEXTE NATIONAL\n{situation}\n\n{questions}\n\nQUESTIONS DIFFICILES PAR CANDIDAT\n{hard}',
    })

preset = {
    'date': '11 novembre 2026',
    'topic': "Où va la France ? Le gouvernement, le budget 2027 rejeté à l'Assemblée et les projets des principaux candidats à la présidentielle d'avril 2027, face aux questions qu'ils évitent.",
    'context': "Sébastien Lecornu est Premier ministre sans majorité. L'Assemblée a rejeté la partie recettes du budget 2027 le 4 novembre par 458 voix contre 0 ; le Parlement a jusqu'au 17 décembre. Premier tour le 18 avril 2027. Les sièges « Voix de » présentent les positions publiques documentées des candidats ; trois intervieweuses posent les questions difficiles.",
    'seats': seats,
}
page = root / 'artifact' / 'index.html'
html = page.read_text()
blob = json.dumps(preset, ensure_ascii=False).replace('</', '<\\/')
html, n = re.subn(r'/\*RESEARCH\*/.*?/\*END\*/', lambda _: f'/*RESEARCH*/{blob}/*END*/', html, flags=re.S)
assert n == 1, 'RESEARCH marker not found'
page.write_text(html)
print('candidates found:', ', '.join(candidates) or 'none')
print('seats without research:', ', '.join(s['name'] for s in seats if not s['dossier']) or 'none')
print('deep dossiers:', ', '.join(n for n, _, _ in TABLE if deep(n)) or 'none yet')
print('page size:', len(html.encode()) // 1024, 'KB')
