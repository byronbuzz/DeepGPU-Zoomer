// Adapted from QD b1c8ddfd: renorm(5), sloppy_add (the default) and accurate_mul.
// f32 splitter 4097; mantissas are normalized by the caller.
fn qQuick(a:f32,b:f32,e:ptr<function,f32>)->f32 {
    let s=a+b;
    *e=b-(s-a);
    return s;
}
fn qTwo(a:f32,b:f32,e:ptr<function,f32>)->f32 {
    let s=a+b;
    let bb=s-a;
    *e=(a-(s-bb))+(b-bb);
    return s;
}
fn qProd(a:f32,b:f32,e:ptr<function,f32>)->f32 {
    let p=a*b;
    let ta=4097.0*a;
    let tb=4097.0*b;
    let ah=ta-(ta-a);
    let bh=tb-(tb-b);
    let al=a-ah;
    let bl=b-bh;
    *e=((ah*bh-p)+ah*bl+al*bh)+al*bl;
    return p;
}
fn qRenorm(v:vec4f,tail:f32)->vec4f {
    var c0=v.x;
    var c1=v.y;
    var c2=v.z;
    var c3=v.w;
    var c4=tail;
    var s0=qQuick(c3,c4,&c4);
    s0=qQuick(c2,s0,&c3);
    s0=qQuick(c1,s0,&c2);
    c0=qQuick(c0,s0,&c1);
    s0=c0;
    var s1=c1;
    var s2=0.0;
    var s3=0.0;
    if(s1!=0.0){
        s1=qQuick(s1,c2,&s2);
        if(s2!=0.0){
            s2=qQuick(s2,c3,&s3);
            if(s3!=0.0){
                s3+=c4;
            }
            else{
                s2=qQuick(s2,c4,&s3);
            }
        }
        else{
            s1=qQuick(s1,c3,&s2);
            if(s2!=0.0){
                s2=qQuick(s2,c4,&s3);
            }
            else{
                s1=qQuick(s1,c4,&s2);
            }
        }
    }
    else{
        s0=qQuick(s0,c2,&s1);
        if(s1!=0.0){
            s1=qQuick(s1,c3,&s2);
            if(s2!=0.0){
                s2=qQuick(s2,c4,&s3);
            }
            else{
                s1=qQuick(s1,c4,&s2);
            }
        }
        else{
            s0=qQuick(s0,c3,&s1);
            if(s1!=0.0){
                s1=qQuick(s1,c4,&s2);
            }
            else{
                s0=qQuick(s0,c4,&s1);
            }
        }
    }
    return vec4f(s0,s1,s2,s3);
}
fn qAdd(a:vec4f,b:vec4f)->vec4f {
    let sums=a+b;
    let v=sums-a;
    let errors=(a-(sums-v))+(b-v);
    var s1=sums.y;
    var s2=sums.z;
    var s3=sums.w;
    var t0=errors.x;
    var t1=errors.y;
    s1=qTwo(s1,t0,&t0);
    qThree(&s2,&t0,&t1);
// QD three_sum2(s3,t0,t2).
    var e1=0.0;
    var e2=0.0;
    let t=qTwo(s3,t0,&e1);
    s3=qTwo(errors.z,t,&e2);
    t0=e1+e2;
    t0=t0+t1+errors.w;
    return qRenorm(vec4f(sums.x,s1,s2,s3),t0);
}
fn qThree(a:ptr<function,f32>,b:ptr<function,f32>,c:ptr<function,f32>){
    var t2=0.0;
    var t3=0.0;
    let t1=qTwo(*a,*b,&t2);
    let av=qTwo(*c,t1,&t3);
    var cv=0.0;
    let bv=qTwo(t2,t3,&cv);
    *a=av;
    *b=bv;
    *c=cv;
}
fn qMul(a:vec4f,b:vec4f)->vec4f {
    var q0=0.0;
    var q1=0.0;
    var q2=0.0;
    var q3=0.0;
    var q4=0.0;
    var q5=0.0;
    var p0=qProd(a.x,b.x,&q0);
    var p1=qProd(a.x,b.y,&q1);
    var p2=qProd(a.y,b.x,&q2);
    var p3=qProd(a.x,b.z,&q3);
    var p4=qProd(a.y,b.y,&q4);
    var p5=qProd(a.z,b.x,&q5);
    qThree(&p1,&p2,&q0);
    qThree(&p2,&q1,&q2);
    qThree(&p3,&p4,&p5);
    var t0=0.0;
    var t1=0.0;
    let s0=qTwo(p2,p3,&t0);
    var s1=qTwo(q1,p4,&t1);
    var s2=q2+p5;
    s1=qTwo(s1,t0,&t0);
    s2+=t0+t1;
    var q6=0.0;
    var q7=0.0;
    var q8=0.0;
    var q9=0.0;
    var p6=qProd(a.x,b.w,&q6);
    var p7=qProd(a.y,b.z,&q7);
    var p8=qProd(a.z,b.y,&q8);
    var p9=qProd(a.w,b.x,&q9);
    q0=qTwo(q0,q3,&q3);
    q4=qTwo(q4,q5,&q5);
    p6=qTwo(p6,p7,&p7);
    p8=qTwo(p8,p9,&p9);
    t0=qTwo(q0,q4,&t1);
    t1+=q3+q5;
    var r1=0.0;
    let r0=qTwo(p6,p8,&r1);
    r1+=p7+p9;
    q3=qTwo(t0,r0,&q4);
    q4+=t1+r1;
    t0=qTwo(q3,s1,&t1);
    t1+=q4;
    t1+=a.y*b.w+a.z*b.z+a.w*b.y+q6+q7+q8+q9+s2;
    return qRenorm(vec4f(p0,p1,s0,t0),t1);
}
