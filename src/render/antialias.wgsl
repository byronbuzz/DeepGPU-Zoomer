// WGSL adaptation of mattdesl/glsl-fxaa FXAA v2, pinned in NOTICE.md.
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i:u32)->VsOut{
  var p=array<vec2<f32>,4>(vec2<f32>(-1.0,-1.0),vec2<f32>(1.0,-1.0),vec2<f32>(-1.0,1.0),vec2<f32>(1.0,1.0));
  var out:VsOut;out.pos=vec4<f32>(p[i],0.0,1.0);out.uv=vec2<f32>((p[i].x+1.0)*.5,(1.0-p[i].y)*.5);return out;
}
fn luma(c:vec3<f32>)->f32{return dot(c,vec3<f32>(.2126,.7152,.0722));}
fn sampleRgb(uv:vec2<f32>)->vec3<f32>{return textureSample(source,linearSampler,clamp(uv,vec2<f32>(0.0),vec2<f32>(1.0))).rgb;}
@fragment fn fs(in:VsOut)->@location(0) vec4<f32>{
  let inverse=1.0/vec2<f32>(textureDimensions(source));let centre=textureSample(source,linearSampler,in.uv);
  let nw=sampleRgb(in.uv+vec2<f32>(-1.0,-1.0)*inverse);let ne=sampleRgb(in.uv+vec2<f32>(1.0,-1.0)*inverse);
  let sw=sampleRgb(in.uv+vec2<f32>(-1.0,1.0)*inverse);let se=sampleRgb(in.uv+vec2<f32>(1.0,1.0)*inverse);
  let lnw=luma(nw);let lne=luma(ne);let lsw=luma(sw);let lse=luma(se);let lm=luma(centre.rgb);
  let low=min(lm,min(min(lnw,lne),min(lsw,lse)));let high=max(lm,max(max(lnw,lne),max(lsw,lse)));
  var direction=vec2<f32>(-((lnw+lne)-(lsw+lse)),(lnw+lsw)-(lne+lse));
  let reduce=max((lnw+lne+lsw+lse)*(.25*.125),1.0/128.0);let reciprocal=1.0/(min(abs(direction.x),abs(direction.y))+reduce);
  direction=clamp(direction*reciprocal,vec2<f32>(-8.0),vec2<f32>(8.0))*inverse;
  let a=.5*(sampleRgb(in.uv+direction*(-1.0/6.0))+sampleRgb(in.uv+direction*(1.0/6.0)));
  let b=a*.5+.25*(sampleRgb(in.uv+direction*(-.5))+sampleRgb(in.uv+direction*.5));let lb=luma(b);
  return vec4<f32>(select(b,a,lb<low||lb>high),centre.a);
}
