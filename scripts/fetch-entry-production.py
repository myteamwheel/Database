"""Build identity-matched college inputs from SportsDataverse's ESPN box scores.
Requires pyarrow. Raw files stay in --cache-dir; output contains candidate totals
and hashes so the website and CI consume a small deterministic JSON snapshot.
"""
import argparse,collections,datetime,hashlib,json,math,pathlib,re,subprocess,unicodedata
import pyarrow.parquet as pq
ROOT=pathlib.Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--cache-dir',type=pathlib.Path,required=True);p.add_argument('--first-year',type=int,default=2015);p.add_argument('--last-year',type=int,default=2026);a=p.parse_args()
def namekey(s):
 s=unicodedata.normalize('NFKD',s or '').encode('ascii','ignore').decode().lower()
 return re.sub(r'[^a-z0-9]','',re.sub(r'\b(jr|sr|ii|iii|iv)\b\.?','',s))
inputs=json.loads((ROOT/'scripts/data/projection/inputs.json').read_text());roster=json.loads((ROOT/'scripts/data/live/roster.json').read_text())
people={}
for table in [inputs['playerIndex'],roster]:
 for row in table['rows']:
  r=dict(zip(table['headers'],row));people[r['PERSON_ID']]=r
names=collections.defaultdict(list)
for pid,r in people.items():names[namekey(r['PLAYER_FIRST_NAME']+' '+r['PLAYER_LAST_NAME'])].append(pid)
# Earliest *played* NBA year establishes the pre-entry cutoff. A draft/index year
# does not falsely create a season of playing history for delayed debuts.
first={}
for season,tables in sorted(inputs['nba'].items()):
 table=tables['base'];ix={k:i for i,k in enumerate(table['headers'])}
 for r in table['rows']:
  if r[ix['GP']]>0:first.setdefault(r[ix['PLAYER_ID']],int(season[:4]))
fields={'min':'minutes','pts':'points','oreb':'offensive_rebounds','dreb':'defensive_rebounds','reb':'rebounds','ast':'assists','stl':'steals','blk':'blocks','tov':'turnovers','fgm':'field_goals_made','fga':'field_goals_attempted','fg3m':'three_point_field_goals_made','fg3a':'three_point_field_goals_attempted','ftm':'free_throws_made','fta':'free_throws_attempted'}
records=[];sources=[];rejected=collections.Counter();a.cache_dir.mkdir(parents=True,exist_ok=True)
for year in range(a.first_year,a.last_year+1):
 url=f'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_mens_college_basketball_player_boxscores/player_box_{year}.parquet';file=a.cache_dir/f'player_box_{year}.parquet'
 if not file.exists():subprocess.run(['curl','--fail','--location','--silent','--show-error','--retry','2','--max-time','150',url,'-o',str(file)],check=True)
 columns=['game_id','game_date','athlete_id','athlete_display_name','team_location','did_not_play',*fields.values()]
 table=pq.read_table(file,columns=columns);group={};seen=set();ids=collections.defaultdict(set)
 rows=table.to_pylist();invalid_players=set()
 for r in rows:
  key=namekey(r['athlete_display_name'])
  if len(names.get(key,[]))==1:ids[key].add(r['athlete_id'])
 for r in rows:
  key=namekey(r['athlete_display_name']);match=names.get(key,[])
  if len(match)!=1 or len(ids[key])!=1:continue
  pid=match[0]
  if year>first.get(pid,2026):continue
  if r['did_not_play'] or not r['minutes']:continue
  identity=(r['game_id'],r['athlete_id'])
  if identity in seen:raise ValueError('Duplicate college player game')
  seen.add(identity)
  v={k:r[f] for k,f in fields.items()}
  if any(not isinstance(x,(float,int)) or not math.isfinite(x) or x<0 for x in v.values()):rejected['missing_or_invalid_count']+=1;invalid_players.add(pid);continue
  if v['pts']!=2*v['fgm']+v['fg3m']+v['ftm'] or v['reb']!=v['oreb']+v['dreb'] or v['fgm']>v['fga'] or v['fg3m']>v['fg3a'] or v['ftm']>v['fta']:rejected['accounting_failure']+=1;invalid_players.add(pid);continue
  d=str(r['game_date'])
  if d>=f'{year}-10-01':raise ValueError('College row crosses the NBA entry cutoff')
  q=group.setdefault(pid,{'playerId':str(pid),'name':people[pid]['PLAYER_FIRST_NAME']+' '+people[pid]['PLAYER_LAST_NAME'],'collegeName':r['athlete_display_name'],'collegeAthleteId':r['athlete_id'],'seasonEndYear':year,'nbaEntryYear':first.get(pid),'games':0,'totals':dict.fromkeys(fields,0),'teams':set(),'lastGameDate':d,'identityMethod':'unique normalized full name in both NBA index and college season; suffixes omitted'})
  q['games']+=1;q['teams'].add(r['team_location']);q['lastGameDate']=max(q['lastGameDate'],d)
  for k,x in v.items():q['totals'][k]+=x
 for q in group.values():
  if int(q['playerId']) not in invalid_players and q['games']>=10 and q['totals']['min']>=100:q['teams']=sorted(q['teams']);records.append(q)
 sources.append({'seasonEndYear':year,'url':url,'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'rows':table.num_rows})
 print(year,'matched seasons',len(group),flush=True)
records.sort(key=lambda r:(int(r['playerId']),r['seasonEndYear']))
output={'version':1,'source':'SportsDataverse normalized ESPN NCAA game box scores','sourceDocumentation':'https://github.com/sportsdataverse/hoopR-mbb-data/blob/main/docs/datasets/player_box.md','identityBoundary':'Unique name crosswalk, not an NBA/ESPN ID crosswalk. Ambiguous names are withheld; source school names and ESPN athlete IDs are retained for independent review. International leagues and incomplete college seasons use explicit entry-cohort fallbacks. Historical NBA-index coverage can omit nonappearing undrafted entrants.','sources':sources,'rejectedRows':dict(rejected),'records':records}
file=ROOT/'scripts/data/projection/entry-production.json';file.write_text(json.dumps(output,separators=(',',':'))+'\n');print('Wrote',len(records),'matched college seasons for',len(set(r['playerId'] for r in records)),'NBA identities')
