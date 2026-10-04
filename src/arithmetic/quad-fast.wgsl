// Adapted from QD b1c8ddfd sloppy_mul, preserving a four-word expansion.
// Lower-order products are uncompensated; qMul remains the accurate fallback.
// First six compensated products and their accumulation match qMul.
fn qMulFast(a:vec4f,b:vec4f)->vec4f {
    var q0=0.0; var q1=0.0; var q2=0.0;
    var q3=0.0; var q4=0.0; var q5=0.0;
    var p0=qProd(a.x,b.x,&q0);
    var p1=qProd(a.x,b.y,&q1);
    var p2=qProd(a.y,b.x,&q2);
    var p3=qProd(a.x,b.z,&q3);
    var p4=qProd(a.y,b.y,&q4);
    var p5=qProd(a.z,b.x,&q5);
    qThree(&p1,&p2,&q0);
    qThree(&p2,&q1,&q2);
    qThree(&p3,&p4,&p5);
    var t0=0.0; var t1=0.0;
    let s0=qTwo(p2,p3,&t0);
    var s1=qTwo(q1,p4,&t1);
    var s2=q2+p5;
    s1=qTwo(s1,t0,&t0);
    s2+=t0+t1;
    s1+=a.x*b.w+a.y*b.z+a.z*b.y+a.w*b.x+q0+q3+q4+q5;
    return qRenorm(vec4f(p0,p1,s0,s1),s2);
}
