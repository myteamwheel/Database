import {pathToFileURL} from 'node:url';
export async function dispatchPages({repository=process.env.GITHUB_REPOSITORY,token=process.env.GH_TOKEN,fetcher=fetch}={}) {
  if(repository!=='myteamwheel/Database'||!token)throw new Error('Production repository and workflow token required');
  const response=await fetcher(`https://api.github.com/repos/${repository}/actions/workflows/deploy-pages.yml/dispatches`,{method:'POST',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json'},body:JSON.stringify({ref:'v3-official-data'})});
  if(response.status!==204)throw new Error('Pages dispatch failed: HTTP '+response.status);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){await dispatchPages();console.log('Pages publication requested');}
