import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {DEFAULT_TUNING,WORKGROUP_SHAPES} from '../../src/tuning';
import {deliveryWorkgroup} from '../../src/render/delivery-workgroup';

const shader=readFileSync(new URL('../../src/render/perturbation.wgsl',import.meta.url),'utf8');
const renderer=readFileSync(new URL('../../src/render/webgpu-renderer.ts',import.meta.url),'utf8');
const wide=readFileSync(new URL('../../src/render/wide.wgsl',import.meta.url),'utf8');
const {x:wx,y:wy}=deliveryWorkgroup(DEFAULT_TUNING.workgroupShape);
const shapes=WORKGROUP_SHAPES.map(shape=>deliveryWorkgroup(shape));
const entry=shader.slice(shader.indexOf('fn compute('));
const condition=entry.match(/if \((sampleMode\(\).*?)\) \{\s*position = vec2<u32>/s)![1];
const coordinates=entry.match(/position = vec2<u32>\((.*?),\s*(.*?)\);/s)!;

// Execute the actual source expressions as WGSL unsigned integer arithmetic.
// This avoids implementing a second parity mapping and comparing it to itself.
function evaluate(expression:string,values:Record<string,number>):number {
  const tokens=expression.match(/[A-Za-z_]\w*(?:\.\w+)?|\d+u?|&&|\|\||==|!=|<=|>=|[()+*/%<>-]/g)!;
  let at=0;
  const precedence:Record<string,number>={'||':1,'&&':2,'==':3,'!=':3,'<':4,'<=':4,'>':4,'>=':4,'+':5,'-':5,'*':6,'/':6,'%':6};
  const operation=(op:string,a:number,b:number):number=>{
    switch(op){case '+':return a+b;case '-':return a-b;case '*':return a*b;case '/':return Math.floor(a/b);case '%':return a%b;
      case '==':return Number(a===b);case '!=':return Number(a!==b);case '<':return Number(a<b);case '<=':return Number(a<=b);
      case '>':return Number(a>b);case '>=':return Number(a>=b);case '&&':return Number(!!a&&!!b);case '||':return Number(!!a||!!b);}
    throw Error('Unsupported operator '+op);
  };
  const parse=(minimum=0):number=>{
    const token=tokens[at++];
    let value:number;
    if(token==='('){value=parse();if(tokens[at++]!==')')throw Error('Missing closing parenthesis');}
    else if(/^\d/.test(token))value=Number(token.replace(/u$/,''));
    else {value=values[token];if(value===undefined)throw Error('Unknown identifier '+token);if(tokens[at]==='('){at++;if(tokens[at++]!==')')throw Error('Unexpected arguments');}}
    while(at<tokens.length&&precedence[tokens[at]]!==undefined&&precedence[tokens[at]]>=minimum){const op=tokens[at++];value=operation(op,value,parse(precedence[op]+1));}
    return value;
  };
  const result=parse();if(at!==tokens.length)throw Error('Unparsed expression '+expression);return result;
}

function position(x:number,y:number,columns:number,rows:number,reuse=1,mode=0,grid=1,sizeX=wx,sizeY=wy):[number,number] {
  const values={'gid.x':x,'gid.y':y,columns,rows,'u.reuseField':reuse,sampleMode:mode,sampleGrid:grid,
    SAMPLE_WORKGROUP_X:sizeX,SAMPLE_WORKGROUP_Y:sizeY,blockX:2*sizeX,blockY:2*sizeY};
  return evaluate(condition,values)?[evaluate(coordinates[1],values),evaluate(coordinates[2],values)]:[x,y];
}

describe('ordinary specialization coordinate contract',()=>{
  it('maps every selectable shape to its independent dispatch dimensions',()=>{
    expect(WORKGROUP_SHAPES.map(shape=>[shape,deliveryWorkgroup(shape)])).toEqual([
      ['8x4',{x:8,y:4}],['16x4',{x:16,y:4}],['8x8',{x:8,y:8}],
      ['24x4',{x:24,y:4}],['32x4',{x:32,y:4}],['64x4',{x:64,y:4}],
    ]);
    for(const {x,y} of shapes)expect(x*y).toBeLessThanOrEqual(256);
  });

  it('visits each anchor exactly once across small and clipped rectangles',()=>{
    for(const {x:sizeX,y:sizeY} of shapes)for(const columns of [1,7,8,9,15,16,17,23,24,25,31,32,33,47,48,49,63,64,65,95,96,97,127,128,129])for(const rows of [1,3,4,5,7,8,9,15,16,17,31]){
      const visited=new Uint8Array(columns*rows);
      for(let y=0;y<Math.ceil(rows/sizeY)*sizeY;y++)for(let x=0;x<Math.ceil(columns/sizeX)*sizeX;x++){
        const [col,row]=position(x,y,columns,rows,1,0,1,sizeX,sizeY);
        if(col>=columns||row>=rows)continue;
        expect(col).toBeGreaterThanOrEqual(0);expect(row).toBeGreaterThanOrEqual(0);
        visited[row*columns+col]++;
      }
      expect(visited.every(count=>count===1)).toBe(true);
    }
  });

  it('keeps complete workgroups within one reused-sample parity',()=>{
    for(const {x:sizeX,y:sizeY} of shapes)for(let groupY=0;groupY<4;groupY++)for(let groupX=0;groupX<4;groupX++){
      const parity=new Set<number>();
      for(let y=0;y<sizeY;y++)for(let x=0;x<sizeX;x++){
        const [col,row]=position(groupX*sizeX+x,groupY*sizeY+y,4*sizeX,4*sizeY,1,0,1,sizeX,sizeY);
        parity.add((col&1)+2*(row&1));
      }
      expect(parity.size).toBe(1);
    }
  });

  it('preserves linear mapping without reuse, in other modes and with multisampling',()=>{
    for(const {x:sizeX,y:sizeY} of shapes)for(const [reuse,mode,grid] of [[0,0,1],[1,1,1],[1,2,1],[1,0,2],[2,0,3]])
      for(let y=0;y<17;y++)for(let x=0;x<129;x++)expect(position(x,y,129,17,reuse,mode,grid,sizeX,sizeY)).toEqual([x,y]);
  });

  it('preserves physical sample sets and known-sample skips with strides and nonzero origins',()=>{
    for(const stride of [1,2,4,8,16])for(const [width,height] of [[17,19],[95,33],[97,65],[129,67],[257,131]]){
      const columns=Math.ceil(width/stride),rows=Math.ceil(height/stride),originX=3,originY=7;
      const expected=new Set<string>(),expectedKnown=new Set<string>();
      const known=(x:number,y:number)=>(x*17+y*29)%7<2;
      for(let row=0;row<rows;row++)for(let col=0;col<columns;col++){
        const x=originX+col*stride,y=originY+row*stride,key=x+','+y;expected.add(key);if(known(x,y))expectedKnown.add(key);
      }
      for(const {x:sizeX,y:sizeY} of shapes){
        const visited=new Set<string>(),skipped=new Set<string>();
        for(let y=0;y<Math.ceil(rows/sizeY)*sizeY;y++)for(let x=0;x<Math.ceil(columns/sizeX)*sizeX;x++){
          const [col,row]=position(x,y,columns,rows,2,0,1,sizeX,sizeY);if(col>=columns||row>=rows)continue;
          const physicalX=originX+col*stride,physicalY=originY+row*stride,key=physicalX+','+physicalY;
          visited.add(key);if(known(physicalX,physicalY))skipped.add(key);
        }
        expect(visited).toEqual(expected);expect(skipped).toEqual(expectedKnown);
      }
    }
  });

  it('binds the ordinary workgroup overrides and host dispatch while retaining continuation defaults',()=>{
    expect(shader).toContain('@workgroup_size(SAMPLE_WORKGROUP_X, SAMPLE_WORKGROUP_Y)');
    expect(shader).toContain('override SAMPLE_WORKGROUP_X: u32 = 8u;');
    expect(shader).toContain('override SAMPLE_WORKGROUP_Y: u32 = 4u;');
    expect(renderer).toContain('SAMPLE_WORKGROUP_X:ORDINARY_WORKGROUP_X,SAMPLE_WORKGROUP_Y:ORDINARY_WORKGROUP_Y');
    expect(renderer).toContain('SAMPLE_WORKGROUP_X:x,SAMPLE_WORKGROUP_Y:y');
    expect(renderer).toContain('calculateWorkgroupX=shape.x;calculateWorkgroupY=shape.y;');
    expect(renderer).toContain('Math.ceil(width/region.stride/calculateWorkgroupX),Math.ceil(stripeRows/region.stride/calculateWorkgroupY)');
    expect(renderer).toContain('Math.ceil(width/region.stride/8),Math.ceil(rows/region.stride/4)');
    expect(renderer).toContain("const constants={DIRECT:kind==='direct'?1:0,JULIA:kind.startsWith('julia')?1:0,APPROX:kind==='approx'||kind==='juliaApprox'?1:0}");
    expect(wx*wy).toBeLessThanOrEqual(256);
  });

  it('limits specialization to ordinary plain and linear-BLA calculations',()=>{
    expect(renderer).toContain("(pipelineKind==='plain'||pipelineKind==='approx')&&\n      request.colors.mode===0&&initialGrid===1&&(request.colors.capped??0)===0&&!needsEndpoints(request.colors)");
    expect(wide).toContain('override ORDINARY: bool = false;');
    expect(wide).toContain('return u.mode;');expect(wide).toContain('return max(u.supersample, 1u);');
    expect(wide).toContain('return u.cappedPattern;');expect(wide).toContain('return u.retainEndpoints != 0u;');
  });
});
