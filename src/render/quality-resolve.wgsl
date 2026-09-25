// Match the existing final-colour gamma encoding, including its selected gamma.
// Decode each complete RGB colour before equal-weight averaging, then re-encode.
fn qualityResolve(source:texture_2d<f32>,uv:vec2<f32>,gamma:f32)->vec4<f32>{
    let size=vec2<i32>(textureDimensions(source));
    let p=clamp(vec2<i32>(floor(uv*vec2<f32>(size)/2.0))*2,vec2<i32>(0),size-vec2<i32>(2));
    let a=textureLoad(source,p,0);let b=textureLoad(source,p+vec2<i32>(1,0),0);
    let c=textureLoad(source,p+vec2<i32>(0,1),0);let d=textureLoad(source,p+vec2<i32>(1,1),0);
    // Coarse stamps and held imagery are not four determined samples.
    if(min(min(a.a,b.a),min(c.a,d.a))<0.999){return vec4<f32>(0.0);}
    return vec4<f32>(pow((pow(a.rgb,vec3<f32>(gamma))+pow(b.rgb,vec3<f32>(gamma))+pow(c.rgb,vec3<f32>(gamma))+pow(d.rgb,vec3<f32>(gamma)))*0.25,vec3<f32>(1.0/gamma)),1.0);
}
