#!/usr/bin/env bash
#
# Archive le trafic GitHub de Sankoré.
#
# POURQUOI CE SCRIPT EXISTE
# GitHub ne conserve les clones et les vues que **14 jours glissants**. Passé ce
# délai la donnée n'est pas archivée ailleurs : elle est détruite. Sans ce
# script, il est impossible de répondre dans six mois à « est-ce que ce dépôt
# amène des gens ? » — la question aura perdu ses données.
#
# CE QU'IL NE FAIT PAS
# Il ne dit pas QUI clone. GitHub ne l'expose pas, ni ici ni ailleurs. Ce sont
# des compteurs, jamais des identités.
#
# LECTURE DES CHIFFRES
# Beaucoup de cloneurs « uniques » pour très peu de visiteurs humains, c'est la
# signature des robots : miroirs, scanners de sécurité, indexeurs de paquets,
# crawlers d'entraînement. Le rapport vues/clones vaut plus que le clone brut.
#
# USAGE
#   ./scripts/trafic.sh              # archive le jour même
#   ./scripts/trafic.sh --resume     # affiche l'historique cumulé
#
# INSTALLATION HEBDOMADAIRE (le lundi à 9 h) :
#   crontab -e
#   0 9 * * 1 cd /home/thioye/Thioye/RelayOPS/sankore && ./scripts/trafic.sh >> /tmp/sankore-trafic.log 2>&1

set -euo pipefail

DEPOT="${SANKORE_REPO:-THIOYE97/sankore}"
PAQUET="${SANKORE_NPM:-sankore}"
RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE="$RACINE/.trafic"
JOURNAL="$ARCHIVE/journal.jsonl"

mkdir -p "$ARCHIVE"

# ---------------------------------------------------------------- résumé

if [[ "${1:-}" == "--resume" ]]; then
    if [[ ! -f "$JOURNAL" ]]; then
        echo "Aucune donnée archivée. Lance le script sans argument d'abord."
        exit 0
    fi
    python3 - "$JOURNAL" <<'PY'
import json, sys

# Chaque relevé recouvre 14 jours ; on déduplique par date pour ne pas
# compter deux fois les journées vues par deux relevés successifs.
clones, vues, npm = {}, {}, {}
for ligne in open(sys.argv[1], encoding='utf-8'):
    ligne = ligne.strip()
    if not ligne:
        continue
    e = json.loads(ligne)
    for j in e.get('clones', {}).get('clones', []):
        clones[j['timestamp'][:10]] = (j['count'], j['uniques'])
    for j in e.get('views', {}).get('views', []):
        vues[j['timestamp'][:10]] = (j['count'], j['uniques'])
    if e.get('npm'):
        npm[e['npm'].get('start', '')] = e['npm'].get('downloads', 0)

jours = sorted(set(clones) | set(vues))
if not jours:
    print("Aucune journée enregistrée.")
    raise SystemExit

print(f"{'Jour':<12} {'clones':>7} {'uniq':>6} {'vues':>7} {'uniq':>6}")
print('-' * 42)
tc = tv = 0
for j in jours:
    c, cu = clones.get(j, (0, 0))
    v, vu = vues.get(j, (0, 0))
    tc += c
    tv += v
    if c or v:
        print(f"{j:<12} {c:>7} {cu:>6} {v:>7} {vu:>6}")

print('-' * 42)
print(f"{'TOTAL':<12} {tc:>7} {'':>6} {tv:>7}")
print(f"\n{len(jours)} jours archivés, du {jours[0]} au {jours[-1]}.")

if tv and tc:
    print(f"Rapport clones/vues : {tc/tv:.1f}")
    if tc / tv > 2:
        print("→ Nettement plus de clones que de vues : trafic majoritairement automatisé.")

if npm:
    print(f"\nTéléchargements npm relevés : {sum(npm.values())}")
PY
    exit 0
fi

# ---------------------------------------------------------------- relevé

if ! command -v gh >/dev/null 2>&1; then
    echo "gh introuvable. Installe GitHub CLI : https://cli.github.com" >&2
    exit 1
fi

horodatage="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Relevé du $horodatage — $DEPOT"

# L'API trafic exige un accès en écriture au dépôt.
clones="$(gh api "repos/$DEPOT/traffic/clones" 2>/dev/null || echo 'null')"
views="$(gh api "repos/$DEPOT/traffic/views" 2>/dev/null || echo 'null')"
referrers="$(gh api "repos/$DEPOT/traffic/popular/referrers" 2>/dev/null || echo '[]')"
paths="$(gh api "repos/$DEPOT/traffic/popular/paths" 2>/dev/null || echo '[]')"

# Forks et stars : eux sont attribués, on peut voir qui.
depot="$(gh api "repos/$DEPOT" --jq '{forks:.forks_count,stars:.stargazers_count,watchers:.subscribers_count}' 2>/dev/null || echo '{}')"

# npm : public, sans authentification. Absent tant que le paquet n'est pas publié.
npm="$(curl -sS --max-time 15 "https://api.npmjs.org/downloads/point/last-week/$PAQUET" 2>/dev/null || echo 'null')"
if echo "$npm" | grep -q '"error"'; then npm='null'; fi

python3 - "$JOURNAL" "$horodatage" "$clones" "$views" "$referrers" "$paths" "$depot" "$npm" <<'PY'
import json, sys

chemin, ts = sys.argv[1], sys.argv[2]

def lire(s):
    try:
        v = json.loads(s)
        return None if v == 'null' else v
    except Exception:
        return None

entree = {
    'releve': ts,
    'clones': lire(sys.argv[3]),
    'views': lire(sys.argv[4]),
    'referrers': lire(sys.argv[5]),
    'paths': lire(sys.argv[6]),
    'depot': lire(sys.argv[7]),
    'npm': lire(sys.argv[8]),
}

with open(chemin, 'a', encoding='utf-8') as f:
    f.write(json.dumps(entree, ensure_ascii=False) + '\n')

c = entree['clones'] or {}
v = entree['views'] or {}
d = entree['depot'] or {}
print(f"  clones (14 j) : {c.get('count', '?')} dont {c.get('uniques', '?')} uniques")
print(f"  vues   (14 j) : {v.get('count', '?')} dont {v.get('uniques', '?')} uniques")
print(f"  forks {d.get('forks', '?')} · stars {d.get('stars', '?')} · watchers {d.get('watchers', '?')}")

if entree['npm']:
    print(f"  npm (7 j)     : {entree['npm'].get('downloads')} téléchargements")
else:
    print("  npm           : paquet non publié")

for r in (entree['referrers'] or [])[:5]:
    print(f"  ← {r['referrer']}: {r['count']} ({r['uniques']} uniques)")
PY

echo "Archivé dans $JOURNAL"
