module.exports = function publicPlayer(vid='111', patch={}, videoPatch={}) {
  const data={isSuccess:true,series_id:'123',vid,seriesDetail:{series_id:'123'},
    publicVideoSeo:{available:true,itemId:vid,seriesId:'123'},...patch};
  const video={'@type':'VideoObject',url:`https://hongguoduanju.com/player/123/${vid}`,
    contentUrl:`https://hongguoduanju.com/video/public/${vid}/full.mp4`,...videoPatch};
  return `window._ROUTER_DATA = ${JSON.stringify({loaderData:{'player_(series_id)/(vid)/page':data}})};<script type="application/ld+json">${JSON.stringify(video)}</script>`;
};
