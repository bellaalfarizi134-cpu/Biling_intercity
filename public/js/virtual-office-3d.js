import * as THREE from '/vendor/three.module.min.js';
import { OrbitControls } from '/vendor/OrbitControls.js';
import { GLTFLoader } from '/vendor/GLTFLoader.js';
import { clone as cloneSkinnedModel } from '/vendor/SkeletonUtils.js';

(() => {
 const stage=document.querySelector('.stage');
 if(!stage || !window.WebGLRenderingContext) return;
 stage.classList.add('isometric-scene');
 const canvas=document.createElement('canvas'); canvas.id='office3DCanvas'; canvas.setAttribute('aria-label','Kantor 3D: lantai atas ruang manajer, lantai bawah teknisi dan customer'); stage.prepend(canvas);
 const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false});
 renderer.setPixelRatio(Math.min(devicePixelRatio||1,2)); renderer.setClearColor(0xd8e5ee,1);
 renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
 renderer.outputColorSpace=THREE.SRGBColorSpace;
 const scene=new THREE.Scene(); scene.background=new THREE.Color(0xd8e5ee); scene.fog=new THREE.Fog(0xd8e5ee,18,34);
 const camera=new THREE.PerspectiveCamera(36,1,.1,100); camera.position.set(17,14,20); camera.lookAt(0,2.1,0);
 const controls=new OrbitControls(camera,renderer.domElement); controls.target.set(0,1.5,0); controls.enableDamping=true; controls.dampingFactor=.06; controls.minDistance=12; controls.maxDistance=32; controls.maxPolarAngle=Math.PI*.48; controls.update();
 scene.add(new THREE.HemisphereLight(0xeaf5ff,0x826448,2.1));
 const sun=new THREE.DirectionalLight(0xfff0d7,3); sun.position.set(-7,13,9); sun.castShadow=true; sun.shadow.mapSize.set(1024,1024); scene.add(sun);
 const mat=(color,roughness=.8)=>new THREE.MeshStandardMaterial({color,roughness});
 const materials={floor:mat('#d9b98d'),wall:mat('#e8e0d3'),blue:mat('#567b91'),dark:mat('#263d4b'),wood:mat('#996b45'),trim:mat('#f4e7d1'),glass: new THREE.MeshStandardMaterial({color:'#9bd3e3',roughness:.25,metalness:.1}),green:mat('#47795a'),red:mat('#b86a55'),white:mat('#f8f5ee'),black:mat('#273039'),screen:mat('#4ca6b8'),gold:mat('#d8b46c')};
 const group=new THREE.Group(); scene.add(group);
 const animatedPeople=[];
 const humanoidAssets={};
 const humanoidLoader=new GLTFLoader();
 function attachRiggedHuman(p,index,asset){
  if(p.rigModel)return;
  const model=cloneSkinnedModel(asset.scene);
  model.position.set(p.originX,p.baseY,p.originZ);
  model.scale.setScalar(.82);
  model.rotation.y=0;
  model.traverse(node=>{if(node.isMesh){node.castShadow=true;node.receiveShadow=true;if(Array.isArray(node.material))node.material=node.material.map(m=>m.clone());else if(node.material)node.material=node.material.clone();}});
  p.personGroup.traverse(node=>{if(node.isMesh)node.visible=false;});
  p.personGroup.add(model);
  const mixer=new THREE.AnimationMixer(model);
  const actions={};
  const outfitColors=['#567b91','#824b60','#47795a','#263d4b'],trouserColors=['#263d4b','#30313d','#303f2c','#222a35'];for(const clip of asset.animations){const key=String(clip.name||'').toLowerCase();if(key.includes('walk_relaxed')&&!actions.walk)actions.walk=mixer.clipAction(clip);else if(key.includes('walk_brisk')&&!actions.brisk)actions.brisk=mixer.clipAction(clip);else if(key==='run'&&!actions.run)actions.run=mixer.clipAction(clip);else if(key.includes('walk_carry')&&!actions.carry)actions.carry=mixer.clipAction(clip);else if(key.includes('sit_stand')&&!actions.sit){const sitDown=THREE.AnimationUtils.subclip(clip,'SitDown',0,90,30);actions.sit=mixer.clipAction(sitDown);actions.sit.setLoop(THREE.LoopOnce,1);actions.sit.clampWhenFinished=true;}else if(key.includes('idle_standing')||key==='idle'){if(!actions.idle)actions.idle=mixer.clipAction(clip);}}model.traverse(node=>{if(!node.isMesh)return;const materials=Array.isArray(node.material)?node.material:[node.material];for(const material of materials){if(!material)continue;{const materialName=String(material.name||'').toLowerCase();if(materialName.includes('tailored business fabric')||materialName.includes('original top'))material.color.set(outfitColors[index%outfitColors.length]);else if(materialName.includes('original bottom'))material.color.set(trouserColors[index%trouserColors.length]);}}});
  if(!actions.idle&&asset.animations[0])actions.idle=mixer.clipAction(asset.animations[0]);
  if(actions.idle){actions.idle.play();p.activeRigAction='idle';}
  const rigBones={};model.traverse(node=>{if(node.isBone)rigBones[String(node.name||'').toLowerCase()]=node;});p.rigModel=model;p.rigMixer=mixer;p.rigActions=actions;p.rigBones=rigBones;
 }
 function loadHumanoid(url,kind){humanoidLoader.load(url,asset=>{humanoidAssets[kind]=asset;animatedPeople.forEach((p,i)=>{const roleKind=i===1?'female':'male';if(roleKind===kind)attachRiggedHuman(p,i,asset);});},undefined,error=>console.error('[Virtual Office] Rigged human model failed to load:',kind,error));}
 // Two distinct CC0 human models: Harper (business attire) for customer, Sam (casual male) for technician/network/manager.
 loadHumanoid('/models/OfficeHuman.glb','female');loadHumanoid('/models/OfficeHumanMale.glb','male');
 function cube(parent,x,y,z,w,h,d,material,opts={}){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);m.position.set(x,y+h/2,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m}
 function label(text,x,y,z,color='#203543',size=256){const c=document.createElement('canvas');c.width=size;c.height=64;const q=c.getContext('2d');q.clearRect(0,0,size,64);q.fillStyle='rgba(250,247,239,.94)';q.fillRect(2,4,size-4,56);q.strokeStyle='#9c805f';q.lineWidth=2;q.strokeRect(2,4,size-4,56);q.fillStyle=color;q.font='bold 19px Arial';q.textAlign='center';q.textBaseline='middle';q.fillText(text.toUpperCase(),size/2,33);const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;const s=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,transparent:true,depthTest:false}));s.position.set(x,y,z);s.scale.set(2.15,.48,1);group.add(s);return s}
 function desk(x,z,who,role,shirt,baseY=0){const Y=v=>v+baseY;cube(group,x,Y(.12),z,1.45,.13,.78,materials.wood);cube(group,x-.58,Y(-.08),z-.25,.09,.4,.09,materials.dark);cube(group,x+.58,Y(-.08),z-.25,.09,.4,.09,materials.dark);cube(group,x-.58,Y(-.08),z+.25,.09,.4,.09,materials.dark);cube(group,x+.58,Y(-.08),z+.25,.09,.4,.09,materials.dark);cube(group,x,Y(.43),z-.18,.62,.43,.07,materials.dark);cube(group,x,Y(.46),z-.135,.52,.31,.025,materials.screen);cube(group,x,Y(.29),z+.02,.3,.025,.18,materials.black);cube(group,x,Y(.25),z+.24,.38,.035,.22,materials.white);
 // Smooth, stylized seated 3D human: rounded anatomy, face, hair, hands and moving arms
 // Dedicated chair behind each desk so every seated AI has a visible seat
 cube(group,x,Y(.19),z+.98,.66,.10,.62,materials.dark);
 cube(group,x,Y(.29),z+1.25,.66,.48,.10,materials.blue);
 for(const dx of [-.25,.25])for(const dz of [.76,1.18])cube(group,x+dx,Y(-.02),z+dz,.055,.24,.055,materials.dark);
 const motionPivot=new THREE.Group();motionPivot.position.set(x,0,z);motionPivot.userData.isManager=(who==='AI MANAJER');group.add(motionPivot);const personGroup=new THREE.Group();personGroup.position.set(-x,0,-z);motionPivot.add(personGroup);
 const skin=mat(who==='AI CUSTOMER'?'#a96f4d':who==='AI JARINGAN'?'#edc49b':who==='SM'?'#bd8968':'#d8a27b'), hair=mat(who==='AI CUSTOMER'?'#17191d':who==='AI JARINGAN'?'#4a3020':who==='SM'?'#55402e':'#302820'), shirtMat=mat(shirt), trousers=mat(who==='AI CUSTOMER'?'#26313b':who==='AI JARINGAN'?'#303f2c':who==='SM'?'#252d3c':'#344657'), shoe=mat('#242a30'), eye=mat('#f9f4e9');
 function ball(parent,px,py,pz,sx,sy,sz,material){const m=new THREE.Mesh(new THREE.SphereGeometry(1,20,14),material);m.position.set(px,py,pz);m.scale.set(sx,sy,sz);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
 function rod(parent,a,b,r1,r2,material){const A=new THREE.Vector3(...a),B=new THREE.Vector3(...b),v=B.clone().sub(A);const m=new THREE.Mesh(new THREE.CylinderGeometry(r2,r1,v.length(),12),material);m.position.copy(A.add(B).multiplyScalar(.5));m.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),v.normalize());m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
 const torso=ball(personGroup,x,Y(.48),z+.72,.24,.29,.17,shirtMat);
 // Visible garment details: collar, tie/lanyard and shirt pocket add clothing rather than emoji-like plain bodies.
 const collarL=ball(personGroup,x-.065,Y(.695),z+.585,.075,.045,.035,materials.white);collarL.rotation.z=-.28;
 const collarR=ball(personGroup,x+.065,Y(.695),z+.585,.075,.045,.035,materials.white);collarR.rotation.z=.28;
 if(who==='SM'||who==='AI MANAJER'){
  const tie=mat('#bd4b43');const knot=ball(personGroup,x,Y(.665),z+.555,.035,.04,.025,tie);
  const tieBody= new THREE.Mesh(new THREE.ConeGeometry(.045,.19,4),tie);tieBody.rotation.x=Math.PI;tieBody.position.set(x,Y(.56),z+.56);personGroup.add(tieBody);
 } else {
  const lanyard=mat('#e2c66f');rod(personGroup,[x-.035,Y(.68),z+.55],[x+.015,Y(.49),z+.55],.012,.012,lanyard);
  cube(personGroup,x+.015,Y(.48),z+.545,.07,.075,.018,materials.white);
 }
 const pocket=mat('#ffffff');cube(personGroup,x+.13,Y(.51),z+.555,.075,.09,.018,pocket);
 // Identitas visual khas pekerja Indonesia: seragam teknisi, batik pimpinan, dan hijab customer.
 if(who==='AI TEKNISI'){
  const reflective=mat('#f0ce58'),belt=mat('#263039');
  cube(personGroup,x,Y(.43),z+.535,.34,.055,.025,belt);
  cube(personGroup,x-.105,Y(.49),z+.515,.055,.12,.025,materials.gold);
  cube(personGroup,x+.015,Y(.49),z+.515,.035,.12,.025,reflective);
  cube(personGroup,x+.105,Y(.49),z+.515,.035,.12,.025,reflective);
 } else if(who==='SM'||who==='AI MANAJER'){
  // Motif batik sederhana pada kemeja pimpinan, bukan seragam polos.
  const batik=mat('#d8b46c');
  for(const [bx,by] of [[-.12,.58],[-.055,.53],[.02,.59],[.095,.54]]){
   const motif=ball(personGroup,x+bx,Y(by),z+.555,.022,.032,.012,batik);motif.rotation.z=.55;
  }
 }
 const neck=ball(personGroup,x,Y(.72),z+.72,.07,.09,.07,skin);
 const head=ball(personGroup,x,Y(.88),z+.72,.155,.19,.145,skin);
 ball(personGroup,x,Y(.985),z+.72,.16,.105,.15,hair);
 if(who==='AI CUSTOMER'){
  // Hijab berwarna marun: menutup rambut dan membingkai wajah tanpa menutupi mata.
  const hijab=mat('#713e52');
  ball(personGroup,x,Y(.94),z+.765,.19,.19,.13,hijab);
  ball(personGroup,x-.135,Y(.83),z+.675,.065,.16,.075,hijab);
  ball(personGroup,x+.135,Y(.83),z+.675,.065,.16,.075,hijab);
  ball(personGroup,x,Y(.735),z+.70,.14,.07,.09,hijab);
 }
 // Give each worker a distinct silhouette instead of cloning the same face/hair: side part, curls, or manager's neat hairline.
 if(who==='AI JARINGAN'){ball(personGroup,x-.09,Y(1.005),z+.72,.075,.065,.12,hair);ball(personGroup,x+.105,Y(.96),z+.72,.05,.08,.11,hair);}else if(who==='SM'){ball(personGroup,x-.09,Y(.99),z+.72,.075,.085,.12,hair);}
 ball(personGroup,x-.151,Y(.88),z+.72,.035,.055,.035,skin);ball(personGroup,x+.151,Y(.88),z+.72,.035,.055,.035,skin);
 ball(personGroup,x-.052,Y(.895),z+.59,.018,.022,.012,eye);ball(personGroup,x+.052,Y(.895),z+.59,.018,.022,.012,eye);
 ball(personGroup,x-.05,Y(.895),z+.578,.008,.012,.006,materials.black);ball(personGroup,x+.05,Y(.895),z+.578,.008,.012,.006,materials.black);
 ball(personGroup,x,Y(.85),z+.57,.022,.035,.025,skin);ball(personGroup,x,Y(.805),z+.59,.045,.012,.012,mat('#7d4038'));
 const leftArm=new THREE.Group();leftArm.position.set(x-.2,Y(.61),z+.7);personGroup.add(leftArm);
 rod(leftArm,[0,0,0],[-.025,-.12,-.08],.065,.052,shirtMat);ball(leftArm,-.025,-.12,-.08,.055,.055,.055,shirtMat);rod(leftArm,[-.025,-.12,-.08],[-.015,-.28,-.32],.045,.032,skin);ball(leftArm,-.015,-.28,-.32,.04,.035,.04,skin);
 const rightArm=new THREE.Group();rightArm.position.set(x+.2,Y(.61),z+.7);personGroup.add(rightArm);
 rod(rightArm,[0,0,0],[.025,-.12,-.08],.065,.052,shirtMat);ball(rightArm,.025,-.12,-.08,.055,.055,.055,shirtMat);rod(rightArm,[.025,-.12,-.08],[.015,-.28,-.32],.045,.032,skin);ball(rightArm,.015,-.28,-.32,.04,.035,.04,skin);
 // Articulated legs: hip pivots let thighs and shins swing while walking instead of sliding like a statue.
 const leftLeg=new THREE.Group();leftLeg.position.set(x-.12,Y(.34),z+.75);personGroup.add(leftLeg);
 rod(leftLeg,[0,0,0],[-.015,-.19,.015],.078,.067,trousers);
 const leftShin=new THREE.Group();leftShin.position.set(-.015,-.19,.015);leftLeg.add(leftShin);
 rod(leftShin,[0,0,0],[0,-.13,.045],.058,.048,trousers);ball(leftShin,0,-.16,.13,.105,.05,.17,shoe);
 const rightLeg=new THREE.Group();rightLeg.position.set(x+.12,Y(.34),z+.75);personGroup.add(rightLeg);
 rod(rightLeg,[0,0,0],[.015,-.19,.015],.078,.067,trousers);
 const rightShin=new THREE.Group();rightShin.position.set(.015,-.19,.015);rightLeg.add(rightShin);
 rod(rightShin,[0,0,0],[0,-.13,.045],.058,.048,trousers);ball(rightShin,0,-.16,.13,.105,.05,.17,shoe);
 const sleepZzz=label('Zzz',x+.30,Y(1.28),z+.70,'#244b72',128);sleepZzz.scale.set(.72,.34,1);sleepZzz.visible=false;
 const person={personGroup,motionPivot,torso,head,leftArm,rightArm,leftLeg,rightLeg,leftShin,rightShin,sleepZzz,phase:animatedPeople.length*1.7,baseY,originX:x,originZ:z+.72,mode:'work',autonomy:{goal:0,nextAt:performance.now()+1800+Math.random()*4200,waypoint:0,turn:0,walking:false}};animatedPeople.push(person);const personIndex=animatedPeople.length-1;const asset=humanoidAssets[personIndex===1?'female':'male'];if(asset)attachRiggedHuman(person,personIndex,asset);
 const aiNameLabel=label(who,x,Y(.98),z+.75,'#203543',256);const aiRoleLabel=label(role,x,Y(.45),z+1.25,'#415363',256);
 // Hide labels after 20 seconds so they no longer cover the animated 3D characters.
 window.setTimeout(()=>{aiNameLabel.visible=false;aiRoleLabel.visible=false;},5000);
 }
 // Base platform and two separate visible floors
 cube(group,0,-.28,0,15.5,.25,7.8,materials.dark);
 cube(group,0,-.02,0,15.2,.12,7.5,materials.floor);
// Dedicated side annexes: prayer room, pantry and rest lounge
const annexFloor=mat('#c9a879'), prayerGreen=mat('#4c806b'), cushion=mat('#8d6a9b');
const musallaCarpet=mat('#1f6650'),carpetGold=mat('#d9bd7b'),mihrabMat=mat('#d9c08a');
cube(group,-6.25,.04,0,2.65,.08,6.25,musallaCarpet);
// Masjid-style musalla: carpet borders and straight saff lines.
cube(group,-6.25,.085,0,2.48,.018,5.95,carpetGold);
cube(group,-6.25,.097,0,2.40,.018,5.87,musallaCarpet);
for(const z of [-2.55,-1.25,.05,1.35,2.65]){cube(group,-6.25,.115,z,2.35,.012,.025,carpetGold);}
for(const x of [-7.38,-5.12])cube(group,x,.115,0,.025,.012,5.72,carpetGold);
// Qibla wall with a gold mihrab arch and two decorative pillars.
cube(group,-6.25,.16,-3.045,1.05,.92,.035,mihrabMat);
cube(group,-6.25,.18,-3.02,.83,.84,.045,prayerGreen);
const mihrabShape=new THREE.Shape();mihrabShape.moveTo(-.43,0);mihrabShape.lineTo(-.43,.62);mihrabShape.quadraticCurveTo(-.43,.94,0,.94);mihrabShape.quadraticCurveTo(.43,.94,.43,.62);mihrabShape.lineTo(.43,0);mihrabShape.closePath();
const mihrabMesh=new THREE.Mesh(new THREE.ShapeGeometry(mihrabShape),carpetGold);mihrabMesh.position.set(-6.25,.18,-2.985);group.add(mihrabMesh);
const mihrabInner=new THREE.Mesh(new THREE.ShapeGeometry(mihrabShape),prayerGreen);mihrabInner.scale.set(.82,.82,1);mihrabInner.position.set(-6.25,.23,-2.97);group.add(mihrabInner);
for(const x of [-7.35,-5.15]){const col=new THREE.Mesh(new THREE.CylinderGeometry(.055,.07,1.02,12),mihrabMat);col.position.set(x,.62,-2.91);group.add(col);const cap=new THREE.Mesh(new THREE.CylinderGeometry(.095,.095,.09,12),carpetGold);cap.position.set(x,1.16,-2.91);group.add(cap);}
cube(group,-7.58,.08,0,.09,1.25,6.25,materials.wall);cube(group,-6.25,.08,-3.12,2.65,1.25,.09,materials.wall);cube(group,-6.25,.08,3.12,2.65,1.25,.09,materials.wall);
// Shaf lurus: imam di depan, tiga makmum sejajar satu baris di belakang.
const prayerSpots=[[-6.25,-2.05],[-7.0,-.15],[-6.25,-.15],[-5.5,-.15]];
for(const [px,pz] of prayerSpots){cube(group,px,.09,pz,.68,.025,1.12,prayerGreen);cube(group,px,.12,pz,.56,.012,.96,materials.gold);cube(group,px,.20,pz-.30,.23,.035,.16,materials.dark);cube(group,px,.24,pz-.30,.21,.025,.14,materials.green);}
cube(group,-6.25,.2,-2.98,.7,.55,.08,materials.green);
label('RUANG SALAT',-6.25,1.55,2.35,'#244b40',256);
cube(group,6.25,.04,0,2.65,.08,6.25,annexFloor);
cube(group,4.94,.08,0,.09,1.25,6.25,materials.wall);cube(group,6.25,.08,-3.12,2.65,1.25,.09,materials.wall);cube(group,6.25,.08,3.12,2.65,1.25,.09,materials.wall);
cube(group,6.25,.08,0,2.65,.95,.08,materials.trim);
label('PANTRY · MAKAN',6.25,1.55,-2.35,'#5b3b22',256);
cube(group,6.25,.46,-1.5,1.65,.12,1.05,materials.wood);
// Four real-looking dining chairs facing the table; characters sit directly in front of them.
for(const [x,z] of [[5.55,-.72],[6.95,-.72],[5.55,-2.28],[6.95,-2.28]]){
 cube(group,x,.22,z,.58,.10,.58,materials.blue);
 cube(group,x,.30,z+.22,.58,.48,.09,materials.dark);
 for(const dx of [-.22,.22])for(const dz of [-.20,.20])cube(group,x+dx,.02,z+dz,.055,.22,.055,materials.dark);
}
// Food bowls, visible portions, cups and utensils so the meal is readable in the 3D scene.
for(const [x,z] of [[5.8,-1.5],[6.25,-1.5],[6.7,-1.5]]){
 const plate=new THREE.Mesh(new THREE.CylinderGeometry(.17,.15,.035,24),materials.white);plate.position.set(x,.55,z);group.add(plate);
 const bowl=new THREE.Mesh(new THREE.SphereGeometry(.105,18,12),materials.red);bowl.position.set(x,.585,z);bowl.scale.set(1,.42,1);group.add(bowl);
 for(let k=0;k<3;k++){const food=new THREE.Mesh(new THREE.SphereGeometry(.035,10,8),k===1?materials.gold:materials.green);food.position.set(x-.045+k*.045,.625,z+(k%2?.025:-.025));group.add(food);}
 const cup=new THREE.Mesh(new THREE.CylinderGeometry(.045,.05,.12,14),materials.white);cup.position.set(x+.23,.61,z+.08);group.add(cup);
 const spoon=new THREE.Mesh(new THREE.CylinderGeometry(.012,.012,.22,8),materials.dark);spoon.position.set(x-.23,.59,z+.06);spoon.rotation.x=Math.PI/2;group.add(spoon);
}
label('RUANG ISTIRAHAT',6.25,1.55,2.35,'#5b3b22',256);
cube(group,6.25,.32,1.55,1.75,.35,.62,cushion);cube(group,6.25,.67,1.25,1.75,.45,.16,cushion);cube(group,5.42,.32,1.55,.16,.35,.75,materials.wood);cube(group,7.08,.32,1.55,.16,.35,.75,materials.wood);
cube(group,6.25,.08,2.5,.72,.28,.45,materials.wood);cube(group,6.25,.08,2.5,.08,.38,.08,materials.dark);
cube(group,6.25,.44,2.5,.18,.035,.18,materials.white);cube(group,6.25,.48,2.5,.1,.06,.1,materials.red);
 // Ground floor partitions are low enough to preserve cutaway visibility
 cube(group,-4,.08,-2.15,.12,1.7,2.1,materials.wall);cube(group,-4,.08,2.15,.12,1.7,2.1,materials.wall);cube(group,4.8,.08,-2.15,.12,1.7,2.1,materials.wall);cube(group,4.8,.08,2.15,.12,1.7,2.1,materials.wall);
 cube(group,0,.08,-3.2,9.7,1.7,.12,materials.wall);
 cube(group,-.2,.08,.3,.12,1.15,5.8,materials.trim);
 // Ground-floor windows and wall art
 cube(group,-2.5,.95,-3.11,1.7,.72,.05,materials.glass);cube(group,.1,.95,-3.11,1.7,.72,.05,materials.glass);
 // First floor workers
 desk(-2.8,.6,'AI TEKNISI','OLT / ONU', '#467e9a');
 desk(.1,.6,'AI CUSTOMER','LAYANAN PELANGGAN','#b86a55');
 desk(2.7,.6,'AI JARINGAN','MONITORING JARINGAN','#47795a');
 label('LANTAI 1 · TEKNISI & CUSTOMER',0,1.9,2.8);
 // Proper continuous staircase: 12 broad treads rise all the way to the upper floor.
 const stairWood=mat('#a8754c'),stairEdge=mat('#d6ad7c'),railMat=mat('#d8c7a8');
 for(let i=0;i<12;i++){
  const x=1.25+i*.245,y=.035+i*.19,z=2.48-i*.30;
  cube(group,x,y,z,.43,.19,.72,stairWood);
  cube(group,x,y+.19,z,.44,.025,.74,stairEdge);
  cube(group,x-.19,y+.19,z,.035,.035,.74,materials.dark);
 }
 // Handrails follow the slope on both sides, with evenly spaced balusters.
 for(const side of [-.34,.34]){
  const start=new THREE.Vector3(1.22,.58,2.48+side),end=new THREE.Vector3(4.12,2.78,-1.12+side),direction=end.clone().sub(start);
  const rail=new THREE.Mesh(new THREE.CylinderGeometry(.045,.045,direction.length(),10),railMat);rail.position.copy(start.clone().add(end).multiplyScalar(.5));rail.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),direction.normalize());rail.castShadow=true;group.add(rail);
  for(let i=0;i<9;i++){const f=(i+1)/10,x=1.22+(4.12-1.22)*f,y=.58+(2.78-.58)*f,z=2.48+side+(-1.12-2.48)*f;cube(group,x,y-.25,z,.045,.50,.045,railMat);}
 }
 // Upper floor is raised, with manager office, low walls and glass
 cube(group,0,2.35,-.05,9.7,.18,6.7,materials.dark);cube(group,0,2.47,-.05,9.55,.12,6.55,materials.floor);
 cube(group,-4,2.48,-.05,.12,1.7,6.4,materials.wall);cube(group,4.75,2.48,-.05,.12,1.7,6.4,materials.wall);cube(group,0,2.48,-3.2,9.5,1.7,.12,materials.wall);
 cube(group,-2.5,3.25,-3.11,1.7,.75,.05,materials.glass);cube(group,.1,3.25,-3.11,1.7,.75,.05,materials.glass);
 // Manager office dividers, desk, cabinet and meeting table
 cube(group,-.8,2.5,.05,.12,1.25,3.1,materials.trim);
 desk(-2.45,0,'SM','KOORDINASI & LAPORAN','#304e73',2.5);
 cube(group,1.5,2.62,-.9,1.2,.65,.55,materials.wood);cube(group,1.5,3.3,-.9,.95,.65,.06,materials.dark);cube(group,1.5,3.32,-.86,.8,.48,.025,materials.screen);
 cube(group,2.6,2.62,1.35,1.65,.12,.9,materials.wood);for(let i=0;i<4;i++)cube(group,2.05+i*.36,2.38,1.35,.1,.4,.1,materials.dark);
 label('LANTAI 2 · RUANG SM',0,4.35,2.75);
 // Plants and decorative columns
 for(const [x,z] of [[-4,2.5],[4,2.5],[-4,-2.5],[4,-2.5]]){cube(group,x,.1,z,.42,.28,.42,materials.red);cube(group,x,.42,z,.12,.65,.12,materials.green);cube(group,x,.65,z-.18,.38,.35,.12,materials.green);cube(group,x+.17,.56,z+.08,.25,.3,.12,materials.green)}
 // Office lights
 for(const [x,z,y] of [[-2,-1,4.35],[1,-1,4.35],[2,1,4.35]]){const l=new THREE.PointLight(0xffdfad,12,5);l.position.set(x,y,z);scene.add(l)}
 // Small 3D signage for customer service and manager
 label('INTERCITY AI OFFICE',0,5.15,-.1,'#213a4b',320);
 let targetRot=0,paused=false,activeRoom='Ruang kerja';
 // Each AI has its own route and decision timer: work at its desk, walk to a shared area, pause, then choose another destination independently.
 const autonomousRoutes=[
  [{x:-2.8,z:1.32,y:0,pose:'work',wait:6500},{x:-1.35,z:.35,y:0,pose:'coordinate',wait:2400},{x:5.55,z:-.72,y:0,pose:'meal',wait:7000},{x:6.25,z:1.56,y:.25,pose:'rest',wait:8500},{x:-2.8,z:1.32,y:0,pose:'work',wait:9000}],
  [{x:.1,z:1.32,y:0,pose:'work',wait:5500},{x:1.15,z:.45,y:0,pose:'coordinate',wait:2600},{x:6.95,z:-.72,y:0,pose:'meal',wait:7500},{x:6.25,z:1.56,y:.25,pose:'rest',wait:6000},{x:.1,z:1.32,y:0,pose:'work',wait:8500}],
  [{x:2.7,z:1.32,y:0,pose:'work',wait:7000},{x:1.65,z:.1,y:0,pose:'coordinate',wait:2300},{x:5.55,z:-2.05,y:0,pose:'meal',wait:6500},{x:6.88,z:1.56,y:.25,pose:'rest',wait:8000},{x:2.7,z:1.32,y:0,pose:'work',wait:9500}],
  [{x:-2.45,z:.72,y:2.5,pose:'work',wait:9000},{x:-.9,z:1.8,y:2.5,pose:'walk',wait:1800},{x:1.5,z:1.35,y:2.5,pose:'walk',wait:7000},{x:-2.45,z:.72,y:2.5,pose:'work',wait:8500}]
 ];
 let backendActivity={working:false,runningAiJobs:0,activeProvisioning:0};
 window.addEventListener('virtual-office-backend-activity',e=>{backendActivity={...backendActivity,...(e.detail||{})};});
 // Ask the server-side language model to make fresh decisions for each agent. If the model/API is unavailable, keep the last decision rather than pretending a new one was made.
 let lastDecisionAt=0,decisionRequestInFlight=false;
 async function requestAutonomousDecisions(){if(decisionRequestInFlight||Date.now()-lastDecisionAt<35000)return;decisionRequestInFlight=true;try{const response=await fetch('/admin/api/virtual-office/decisions',{credentials:'same-origin',cache:'no-store'});const payload=await response.json();if(response.ok&&payload.ok&&Array.isArray(payload.decisions)){const routeMap={'AI TEKNISI':0,'AI CUSTOMER':1,'AI JARINGAN':2,'AI SM':3};for(const decision of payload.decisions){const i=routeMap[String(decision.agent||'').toUpperCase()];if(i===undefined||!animatedPeople[i])continue;const p=animatedPeople[i],route=autonomousRoutes[i]||autonomousRoutes[0];const action=String(decision.action||'work');const goalIndex=action==='meal'?2:action==='rest'?3:action==='walk'||action==='coordinate'?1:action==='monitor'?Math.min(4,route.length-1):0;p.autonomy.goal=goalIndex;p.autonomy.nextAt=performance.now()+18000+Math.random()*12000;p.autonomy.decision={action,reason:decision.reason,at:decision.decidedAt};}lastDecisionAt=Date.now();window.dispatchEvent(new CustomEvent('virtual-office-ai-decisions',{detail:{decisions:payload.decisions,provider:payload.provider,updatedAt:lastDecisionAt}}));}else{console.warn('[Virtual Office] AI decisions unavailable',payload.error||response.status);}}catch(error){console.warn('[Virtual Office] AI decision request failed',error.message);}finally{decisionRequestInFlight=false;}}
 requestAutonomousDecisions();window.setInterval(requestAutonomousDecisions,45000);
 let schedule={prayerTimes:[],breakStart:'12:30',breakEnd:'13:00',restStart:'15:30',restEnd:'15:45'};
 let managerMealUntil=0,managerApologyUntil=0;
 const managerApology=label('MAAF, KETIDURAN',-2.45,4.55,.7,'#244b72',256);managerApology.visible=false;
 const managerEatingLabel=label('LAGI MAKAN 🍽',6.95,1.65,-2.05,'#5b3b22',256);managerEatingLabel.visible=false;managerEatingLabel.scale.set(1.55,.38,1);
 const managerRaycaster=new THREE.Raycaster(),managerPointer=new THREE.Vector2();
 renderer.domElement.addEventListener('click',e=>{const r=renderer.domElement.getBoundingClientRect();managerPointer.x=((e.clientX-r.left)/r.width)*2-1;managerPointer.y=-((e.clientY-r.top)/r.height)*2+1;managerRaycaster.setFromCamera(managerPointer,camera);const hits=managerRaycaster.intersectObjects(group.children,true);let hit=hits.length?hits[0].object:null;while(hit&&!hit.userData.isManager)hit=hit.parent;if(hit){managerMealUntil=performance.now()+20000;managerApologyUntil=performance.now()+5000;}});
 window.addEventListener('virtual-office-schedule',e=>{if(e.detail)schedule={...schedule,...e.detail};});
 function toMinutes(v){if(!/^\d{2}:\d{2}$/.test(v||''))return -1;const [h,m]=v.split(':').map(Number);return h*60+m;}
 let prayerWasActive=false,duaUntil=0;
 function currentActivity(){const n=new Date(),m=n.getHours()*60+n.getMinutes(),prayerNow=schedule.prayerTimes.some(v=>{const t=toMinutes(v);return t>=0&&m-t>=-2&&m-t<15;});if(prayerNow){prayerWasActive=true;return 'prayer';}if(prayerWasActive){prayerWasActive=false;duaUntil=performance.now()+25000;}if(performance.now()<duaUntil)return 'dua';if(m>=toMinutes(schedule.breakStart)&&m<toMinutes(schedule.breakEnd))return 'meal';if(m>=toMinutes(schedule.restStart)&&m<toMinutes(schedule.restEnd))return 'rest';return 'work';}
 // Malam Jumat Legi: Thursday 18:00 through Friday 05:00, using the Javanese five-day pasaran cycle.
 function isMalamJumatLegi(){const now=new Date(),h=now.getHours(),d=new Date(now.getFullYear(),now.getMonth(),now.getDate());let target;if(now.getDay()===4&&h>=18){target=new Date(d);target.setDate(target.getDate()+1);}else if(now.getDay()===5&&h<5){target=d;}else{return false;}if(target.getDay()!==5)return false;const anchor=Date.UTC(2025,0,1),utcDate=Date.UTC(target.getFullYear(),target.getMonth(),target.getDate());const days=Math.round((utcDate-anchor)/86400000);return ((days+2)%5+5)%5===0;}
 const ngajiAudio=new Audio('https://server8.mp3quran.net/afs/001.mp3');ngajiAudio.preload='none';ngajiAudio.loop=false;ngajiAudio.muted=true;let ngajiWasActive=false,managerNgajiWasActive=false,managerNgajiRouteDirection=0,managerNgajiPathIndex=0;
 const managerNgajiPath=[{x:-2.45,y:2.5,z:.72},{x:-.9,y:2.5,z:1.8},{x:1.1,y:2.5,z:2.2},{x:3.7,y:2.5,z:-.55},...Array.from({length:12},(_,i)=>({x:1.25+i*.245,y:.23+i*.19,z:2.48-i*.30})).reverse(),{x:1.2,y:.15,z:2.5},{x:-3.3,y:.08,z:0},{x:-4.6,y:.08,z:0},{x:-5.3,y:.08,z:0},{x:-6.25,y:0,z:-2.05}];
 let ngajiAudioUnlocked=false;
 // Do not restart the special ngaji procession just because the page was refreshed mid-session.
 let suppressNgajiUntilWindowEnds=isMalamJumatLegi();
 renderer.domElement.addEventListener('pointerdown',()=>{ngajiAudioUnlocked=true;if(!suppressNgajiUntilWindowEnds&&isMalamJumatLegi()&&allNgajiGathered())ngajiAudio.play().catch(()=>{});});
 function allNgajiGathered(){if(managerNgajiRouteDirection!==0)return false;const targets=[[-7.0,-.15],[-6.25,-.15],[-5.5,-.15],[-6.25,-2.05]];return animatedPeople.every((p,i)=>{const x=p.motionPivot.position.x,z=p.motionPivot.position.z,y=p.baseY+p.motionPivot.position.y;return Math.abs(x-targets[i][0])<.22&&Math.abs(z-targets[i][1])<.22&&Math.abs(y)<.22;});}
 function updateNgajiAudio(active){const ready=active&&allNgajiGathered()&&ngajiAudioUnlocked;if(ready&&!ngajiWasActive){ngajiAudio.currentTime=0;ngajiAudio.play().catch(()=>{});}else if(!ready&&ngajiWasActive){ngajiAudio.pause();ngajiAudio.currentTime=0;}ngajiWasActive=ready;}
 const resize=()=>{const r=stage.getBoundingClientRect();const w=Math.max(320,r.width),h=Math.max(580,r.height);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();};
 resize();window.addEventListener('resize',resize);
 document.querySelectorAll('.room-tab').forEach(btn=>btn.addEventListener('click',()=>{activeRoom=btn.dataset.room||btn.textContent.trim();document.querySelectorAll('.room-tab').forEach(b=>b.classList.toggle('active',b===btn));const title=document.querySelector('.room-title');if(title)title.textContent='INTERCITY · '+activeRoom.toUpperCase()+' AI';targetRot=activeRoom==='Ruang kerja'?0:activeRoom==='Rapat'?.3:activeRoom==='Lobby'?-.35:activeRoom==='Pantry'?.55:activeRoom==='Lounge'?-.5:activeRoom==='Gaming'?.7:activeRoom==='Ruang salat'?.62:activeRoom==='Ruang istirahat'?-.62:.15;}));
 window.addEventListener('virtual-office-motion',e=>{paused=!!(e.detail&&e.detail.paused)});
 function animate(){requestAnimationFrame(animate);const frameNow=performance.now();const deltaSeconds=Math.min(.05,Math.max(.001,(frameNow-(animate.lastFrame||frameNow-16.67))/1000));animate.lastFrame=frameNow;const t=frameNow*.004;if(!paused){group.rotation.y+=(targetRot-group.rotation.y)*.025;group.position.y=Math.sin(performance.now()*.0007)*.025;const ngajiWindow=isMalamJumatLegi();if(!ngajiWindow)suppressNgajiUntilWindowEnds=false;const ngajiActive=ngajiWindow&&!suppressNgajiUntilWindowEnds;updateNgajiAudio(ngajiActive);if(ngajiActive&&!managerNgajiWasActive){managerNgajiRouteDirection=1;managerNgajiPathIndex=1;animatedPeople.forEach((p,i)=>{if(i!==3)p.ngajiStage=0;});}else if(!ngajiActive&&managerNgajiWasActive){managerNgajiRouteDirection=-1;managerNgajiPathIndex=managerNgajiPath.length-1;animatedPeople.forEach((p,i)=>{if(i!==3)p.ngajiStage=2;});}managerNgajiWasActive=ngajiActive;const activity=currentActivity();animatedPeople.forEach((p,i)=>{const route=autonomousRoutes[i]||autonomousRoutes[0];const now=performance.now();if(now>=p.autonomy.nextAt&&(!p.autonomy.decision||Date.now()-Date.parse(p.autonomy.decision.at||0)>50000)){p.autonomy.goal=(p.autonomy.goal+1)%route.length;p.autonomy.nextAt=now+route[p.autonomy.goal].wait+(Math.random()*2600);p.autonomy.walking=true;}const goal=route[p.autonomy.goal]||route[0];const backendWork=i===0?Number(backendActivity.runningAiJobs)>0:i===1?Number(backendActivity.activeCustomerRequests)>0:i===2?Number(backendActivity.activeProvisioning)>0:i===3?Boolean(backendActivity.working):false;const taskActivity=(activity==='prayer'||activity==='dua')?activity:goal.pose;const personActivity=ngajiActive?'ngaji':(i===3&&managerNgajiRouteDirection===-1?'return':(i!==3&&p.ngajiStage===2?'return':taskActivity));let tx=p.originX,tz=p.originZ,ty=p.baseY;if(personActivity==='prayer'||personActivity==='dua'||personActivity==='ngaji'){if(personActivity==='ngaji'&&i!==3&&p.ngajiStage===0){tx=-4.6;tz=0;ty=0;}else{tx=[-7.0,-6.25,-5.5,-6.25][i%4];tz=[-.15,-.15,-.15,-2.05][i%4];ty=0;}}else if(i!==3&&personActivity==='return'&&p.ngajiStage===2){tx=-4.6;tz=0;ty=0;}else if(personActivity==='meal'){tx=[5.55,6.95,5.55,6.95][i%4];tz=[-.95,-.95,-2.05,-2.05][i%4];ty=0;}else if(personActivity==='rest'){tx=[5.62,6.25,6.88,6.25][i%4];tz=[1.56,1.56,1.56,1.56][i%4];ty=.25;}if(!ngajiActive&&activity!=='prayer'&&activity!=='dua'){tx=goal.x;tz=goal.z;ty=goal.y;}if(i===3&&managerNgajiRouteDirection===0&&(activity==='prayer'||activity==='dua')){tx=p.originX;tz=p.originZ;ty=p.baseY;}if(i===3&&managerNgajiRouteDirection!==0){const wp=managerNgajiPath[managerNgajiPathIndex];tx=wp.x;tz=wp.z;ty=wp.y;}/* Waypoints describe the visible body/feet position; the motion pivot sits 0.72m behind that local offset. Convert target Z into pivot coordinates. */tz-=.72;const dx=tx-p.motionPivot.position.x,dz=tz-p.motionPivot.position.z;const distance=Math.hypot(dx,dz);const moveSpeed=i===3?1.25:2.05;const step=Math.min(distance,moveSpeed*deltaSeconds);p.autonomy.walking=distance>.10;p.motionPivot.position.x+=distance>.001?(dx/distance)*step:0;p.motionPivot.position.z+=distance>.001?(dz/distance)*step:0;p.motionPivot.position.y+=(ty-p.baseY-p.motionPivot.position.y)*Math.min(1,moveSpeed*deltaSeconds);if(distance>.12&&personActivity!=='prayer'&&personActivity!=='dua'&&personActivity!=='ngaji'){if(p.rigModel)p.rigModel.rotation.y=Math.atan2(dx,dz);p.motionPivot.rotation.y=0;p.motionPivot.position.y+=(Math.sin(t*5.5+p.phase)*.018);}const arrived=Math.abs(p.motionPivot.position.x-tx)<.16&&Math.abs(p.motionPivot.position.z-tz)<.16;if(p.rigMixer){p.rigMixer.update(deltaSeconds);const desired=distance>.10?(distance>.9&&p.rigActions.brisk?'brisk':'walk'):(personActivity==='work'||personActivity==='meal'||personActivity==='rest'?'sit':'idle');const nextAction=p.rigActions[desired]||p.rigActions.idle;const actionKey=p.rigActions[desired]?desired:'idle';if(nextAction&&p.activeRigAction!==actionKey){const current=p.rigActions[p.activeRigAction];nextAction.reset().fadeIn(.22).play();if(current)current.fadeOut(.22);p.activeRigAction=actionKey;}}if(personActivity==='work'&&arrived&&p.rigBones&&p.activeRigAction==='sit'&&p.rigActions.sit&&p.rigActions.sit.time>=p.rigActions.sit.getClip().duration-.04){const typing=Math.sin(t*8+p.phase);const leftUpper=p.rigBones.upperarm_l,rightUpper=p.rigBones.upperarm_r,leftFore=p.rigBones.lowerarm_l,rightFore=p.rigBones.lowerarm_r,leftHand=p.rigBones.hand_l,rightHand=p.rigBones.hand_r;if(leftUpper)leftUpper.rotation.x+=.035*typing;if(rightUpper)rightUpper.rotation.x-=.035*typing;if(leftFore)leftFore.rotation.z+=.06*Math.sin(t*8+p.phase+1);if(rightFore)rightFore.rotation.z-=.06*Math.sin(t*8+p.phase+1.3);if(leftHand)leftHand.rotation.x+=.08*typing;if(rightHand)rightHand.rotation.x-=.08*typing;const headBone=p.rigBones.head;if(headBone)headBone.rotation.x+=.025*Math.sin(t*1.7+p.phase);}const routeArrived=arrived&&Math.abs(p.motionPivot.position.y-(ty-p.baseY))<.16;if(i!==3&&ngajiActive&&p.ngajiStage===0&&arrived)p.ngajiStage=1;if(i!==3&&!ngajiActive&&p.ngajiStage===2&&arrived)p.ngajiStage=3;if(i===3&&managerNgajiRouteDirection!==0&&routeArrived){if(managerNgajiRouteDirection===1&&managerNgajiPathIndex<managerNgajiPath.length-1)managerNgajiPathIndex++;else if(managerNgajiRouteDirection===-1&&managerNgajiPathIndex>0)managerNgajiPathIndex--;else managerNgajiRouteDirection=0;}if(distance>.10&&personActivity!=='prayer'&&personActivity!=='dua'&&personActivity!=='ngaji'){const stride=Math.sin(t*8.5+p.phase);p.leftArm.rotation.z=stride*.58;p.rightArm.rotation.z=-stride*.58;p.leftArm.rotation.x=-.08+stride*.16;p.rightArm.rotation.x=-.08-stride*.16;p.leftLeg.rotation.x=stride*.48;p.rightLeg.rotation.x=-stride*.48;p.leftShin.rotation.x=Math.max(0,-stride)*.62;p.rightShin.rotation.x=Math.max(0,stride)*.62;p.motionPivot.position.y+=(Math.abs(stride)*.035-p.motionPivot.position.y)*.24;p.torso.rotation.x=.025+Math.abs(stride)*.025;p.head.rotation.x=Math.sin(t*3.5+p.phase)*.035;}else{p.leftArm.rotation.z=Math.sin(t+p.phase)*.12;p.rightArm.rotation.z=Math.sin(t+p.phase+Math.PI)*.12;p.leftLeg.rotation.x*=.72;p.rightLeg.rotation.x*=.72;p.leftShin.rotation.x*=.72;p.rightShin.rotation.x*=.72;}if(personActivity==='work'&&arrived){const typing=Math.sin(t*7+p.phase);p.leftArm.rotation.x=-.18+typing*.12;p.rightArm.rotation.x=-.18-Math.sin(t*7+p.phase+1.2)*.12;p.leftArm.rotation.z=-.18+typing*.08;p.rightArm.rotation.z=.18-Math.sin(t*7+p.phase+1.2)*.08;p.torso.rotation.x=.045+Math.sin(t*1.5+p.phase)*.018;p.head.rotation.x=.10+Math.sin(t*1.7+p.phase)*.025;}p.head.rotation.y=Math.sin(t*.45+p.phase)*.12;p.torso.rotation.x=0;p.head.rotation.x=Math.sin(t*.7+p.phase)*.018;p.head.position.y=p.baseY+.88;p.torso.position.y=p.baseY+.46+Math.sin(t*1.2+p.phase)*.018;if(personActivity==='work'&&arrived){const typing=Math.sin(t*7+p.phase);p.leftArm.rotation.x=-.18+typing*.12;p.rightArm.rotation.x=-.18-Math.sin(t*7+p.phase+1.2)*.12;p.leftArm.rotation.z=-.18+typing*.08;p.rightArm.rotation.z=.18-Math.sin(t*7+p.phase+1.2)*.08;p.leftLeg.rotation.x=1.05;p.rightLeg.rotation.x=1.05;p.leftShin.rotation.x=-1.0+Math.max(0,Math.sin(t*1.3+p.phase))*.08;p.rightShin.rotation.x=-1.0+Math.max(0,Math.sin(t*1.3+p.phase+1))*.08;p.torso.position.y=p.baseY+.40+Math.sin(t*1.5+p.phase)*.012;p.head.position.y=p.baseY+.81;p.torso.rotation.x=.025+Math.sin(t*1.5+p.phase)*.018;p.head.rotation.x=.10+Math.sin(t*1.7+p.phase)*.025;}else if(personActivity!=='prayer'&&personActivity!=='dua'&&personActivity!=='ngaji'){p.leftLeg.rotation.x*=.72;p.rightLeg.rotation.x*=.72;p.leftShin.rotation.x*=.72;p.rightShin.rotation.x*=.72;}if(personActivity==='coordinate'&&arrived){const gesture=Math.sin(t*2.8+p.phase);p.leftArm.rotation.z=-.12+Math.max(0,gesture)*.42;p.rightArm.rotation.z=.12-Math.max(0,-gesture)*.42;p.leftArm.rotation.x=-.12+gesture*.12;p.rightArm.rotation.x=-.12-gesture*.12;p.head.rotation.y=Math.sin(t*1.1+p.phase)*.22;p.head.rotation.x=.02+Math.sin(t*1.8+p.phase)*.025;p.torso.rotation.x=.015+Math.sin(t*1.5+p.phase)*.012;}if(personActivity==='prayer'&&arrived){const cycle=(t*.22+p.phase)%(Math.PI*2);const pose=cycle<1.3?0:cycle<2.5?1:cycle<4.1?2:3;if(pose===0){p.leftArm.rotation.z=-.7;p.rightArm.rotation.z=.7;p.torso.position.y=p.baseY+.46;p.head.position.y=p.baseY+.88;}else if(pose===1){p.leftArm.rotation.z=-.12;p.rightArm.rotation.z=.12;p.torso.position.y=p.baseY+.34;p.torso.rotation.x=.9;p.head.position.y=p.baseY+.72;p.head.rotation.x=.35;}else if(pose===2){p.leftArm.rotation.z=-.05;p.rightArm.rotation.z=.05;p.motionPivot.position.y+=(-.18-p.motionPivot.position.y)*.08;p.torso.position.y=p.baseY+.22;p.torso.rotation.x=1.25;p.head.position.y=p.baseY+.34;p.head.rotation.x=.55;}else{p.leftArm.rotation.z=-.25;p.rightArm.rotation.z=.25;p.torso.position.y=p.baseY+.32;p.head.position.y=p.baseY+.62;p.head.rotation.x=.12;}}else if(personActivity==='dua'&&arrived){
 // Sit calmly after the final prayer and raise both hands for dua.
 p.leftArm.rotation.z=-.82+Math.sin(t*.22+p.phase)*.025;p.rightArm.rotation.z=.82-Math.sin(t*.22+p.phase)*.025;p.leftArm.rotation.x=-.18;p.rightArm.rotation.x=-.18;p.torso.rotation.x=0;p.torso.position.y=p.baseY+.34;p.head.position.y=p.baseY+.78;p.head.rotation.x=.12;
}else if(personActivity==='ngaji'&&arrived&&(i===3?managerNgajiRouteDirection===0:p.ngajiStage===1)){
 // Quiet seated Quran-reading pose: head lowered toward the mushaf, hands held open and gently moving.
 const recite=Math.sin(t*.55+p.phase);
 p.leftArm.rotation.z=-.28+recite*.045;p.rightArm.rotation.z=.28-recite*.045;
 p.leftArm.rotation.x=-.08;p.rightArm.rotation.x=-.08;
 p.head.rotation.x=.22+Math.sin(t*.28+p.phase)*.025;p.head.rotation.y=Math.sin(t*.18+p.phase)*.025;
 p.torso.rotation.x=.08;p.torso.position.y=p.baseY+.43;p.head.position.y=p.baseY+.82;
}else if(personActivity==='meal'&&arrived){
 // Repeated, slower spoon-to-mouth motion with a small head lean and a visible pause between bites.
 const biteCycle=(t*.72+p.phase)%(Math.PI*2),lift=biteCycle<1.05?Math.sin(biteCycle/1.05*Math.PI/2):0;
 p.leftArm.rotation.z=-.12+Math.sin(t*.30+p.phase)*.045;
 p.rightArm.rotation.z=-.12-lift*.78;
 p.leftArm.rotation.x=-.04;p.rightArm.rotation.x=-.20-lift*.48;
 p.head.rotation.x=-.04-lift*.22;p.torso.rotation.x=0;
}else if(personActivity==='rest'&&arrived){p.motionPivot.rotation.y=0;p.leftArm.rotation.z=-.12+Math.sin(t*.45+p.phase)*.035;p.rightArm.rotation.z=.12+Math.sin(t*.45+p.phase+1)*.035;p.leftArm.rotation.x=-.08;p.rightArm.rotation.x=-.08;p.torso.rotation.x=.02;p.head.rotation.x=.03+Math.sin(t*.35+p.phase)*.025;p.torso.position.y=p.baseY+.46;p.head.position.y=p.baseY+.88;p.motionPivot.rotation.z=0;}if(p.sleepZzz){p.sleepZzz.visible=(i===3&&personActivity==='rest');if(p.sleepZzz.visible){p.sleepZzz.position.x=p.originX+.38+Math.sin(t*.7)*.10;p.sleepZzz.position.y=p.baseY+1.30+Math.sin(t*1.1)*.08;p.sleepZzz.position.z=p.originZ-.02;}}if(i===3){const wx=p.motionPivot.position.x,wz=p.motionPivot.position.z,wy=p.baseY+p.motionPivot.position.y+1.55;managerApology.visible=performance.now()<managerApologyUntil;managerApology.position.set(wx,wy,wz);managerApology.scale.set(2.15,.48,1);managerEatingLabel.visible=performance.now()<managerMealUntil&&personActivity==='meal'&&arrived;managerEatingLabel.position.set(wx,wy+.12,wz);managerEatingLabel.scale.set(2.45,.52,1);}if(i===3&&personActivity==='rest'){p.torso.rotation.x=.02;p.head.rotation.x=.03;p.head.rotation.y=0;p.torso.position.y=p.baseY+.46;p.head.position.y=p.baseY+.88;p.leftArm.rotation.z=-.12;p.rightArm.rotation.z=.12;p.leftArm.rotation.x=-.08;p.rightArm.rotation.x=-.08;p.motionPivot.rotation.z=0;}else if(i===3){p.motionPivot.rotation.z=0;}});}controls.update();renderer.render(scene,camera)}
 animate();
})();