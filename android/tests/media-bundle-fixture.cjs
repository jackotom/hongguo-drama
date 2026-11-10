const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('../../node_modules/esbuild');

module.exports = function bundles() {
  const root=path.resolve(__dirname,'..'),generated=new Map();let tv;
  const files={...fs,readFileSync(file,encoding){const key=path.resolve(file);return generated.has(key)?generated.get(key):fs.readFileSync(file,encoding);},
    mkdirSync(){},writeFileSync(file,value){generated.set(path.resolve(file),String(value));},copyFileSync(from,to){generated.set(path.resolve(to),files.readFileSync(from,'utf8'));}};
  function entry(file) {
    const module={exports:{}};
    function requireFixture(name){if(name==='node:fs')return files;if(name==='node:path')return path;if(name.includes('esbuild'))return {...esbuild,buildSync(options){tv=options;}};return require(name);}
    vm.runInNewContext(fs.readFileSync(file,'utf8'),{require:requireFixture,module,__dirname:path.dirname(file),process:{argv:['node',file,'--tv']},console},{filename:file});
    return module.exports;
  }
  entry(path.join(root,'bundle.cjs'));
  const phone=entry(path.join(root,'mobile/bundle.cjs')).buildOptions;
  const virtual={name:'generated-android-assets',setup(build){
    build.onResolve({filter:/[\/]build[\/](?:(?:mobile-)?decrypt\.js|contract\.json)$/},args=>{
      const file=path.resolve(args.resolveDir||root,args.path);
      if(generated.has(file))return {path:file,namespace:'generated'};
    });
    build.onLoad({filter:/.*/,namespace:'generated'},args=>({contents:generated.get(args.path),loader:args.path.endsWith('.json')?'json':'js',resolveDir:path.dirname(args.path)}));
  }};
  return {root,tv,phone,generated,options(base,extra={}){
    const plugins=(base.plugins||[]).map(plugin=>({name:plugin.name,setup(build){
      const bridge={...build};
      for(const kind of ['onResolve','onLoad'])bridge[kind]=(options,callback)=>build[kind]({...options,filter:new RegExp(options.filter.source,options.filter.flags)},callback);
      return plugin.setup(bridge);
    }}));
    const decoder={name:'selected-generated-decoder',setup(build){
      build.onResolve({filter:/^android-decrypt$/},()=>({path:base.alias['android-decrypt'],namespace:'generated'}));
    }};
    return {...base,write:false,logLevel:'silent',metafile:true,...extra,plugins:[...plugins,decoder,virtual,...(extra.plugins||[])]};
  }};
};
