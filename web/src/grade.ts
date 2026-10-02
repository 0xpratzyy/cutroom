// WebGL2 color grading for the live preview: draws a cropped video frame through a 3D LUT.
// The LUT is the same baked table the exporter gives ffmpeg, so preview == export.

const VS = `#version 300 es
in vec2 p;
uniform vec4 crop; // u0 v0 u1 v1 (top-down)
out vec2 uv;
void main() {
  vec2 t = p * 0.5 + 0.5;
  uv = vec2(mix(crop.x, crop.z, t.x), mix(crop.w, crop.y, t.y));
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 uv;
out vec4 o;
uniform sampler2D video;
uniform sampler3D lut;
uniform float n;
uniform bool useLut;
void main() {
  vec3 c = texture(video, uv).rgb;
  if (useLut) c = texture(lut, c * ((n - 1.0) / n) + 0.5 / n).rgb;
  o = vec4(c, 1.0);
}`;

export type Crop = [number, number, number, number];

export class Grader {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private loc: { crop: WebGLUniformLocation; n: WebGLUniformLocation; useLut: WebGLUniformLocation };
  private videoTex: WebGLTexture;
  private lutTex: WebGLTexture;
  private lutSize = 0;

  static supported(): boolean {
    try {
      return !!document.createElement("canvas").getContext("webgl2");
    } catch {
      return false;
    }
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const p = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(p);
    gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
    this.loc = {
      crop: gl.getUniformLocation(prog, "crop")!,
      n: gl.getUniformLocation(prog, "n")!,
      useLut: gl.getUniformLocation(prog, "useLut")!,
    };
    gl.uniform1i(gl.getUniformLocation(prog, "video"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "lut"), 1);

    this.videoTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    for (const [k, v] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ])
      gl.texParameteri(gl.TEXTURE_2D, k, v);

    this.lutTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    for (const [k, v] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE],
    ])
      gl.texParameteri(gl.TEXTURE_3D, k, v);
  }

  /** Upload a baked LUT (size³ RGB floats, red fastest), or null for no grading. */
  setLut(data: Float32Array | null, size = 33) {
    const gl = this.gl;
    if (!data) {
      this.lutSize = 0;
      return;
    }
    const bytes = new Uint8Array(size * size * size * 4);
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      bytes[j] = Math.round(data[i] * 255);
      bytes[j + 1] = Math.round(data[i + 1] * 255);
      bytes[j + 2] = Math.round(data[i + 2] * 255);
      bytes[j + 3] = 255;
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    this.lutSize = size;
  }

  /** Draw `source` (video or image) cropped to `crop` into the canvas. */
  draw(source: TexImageSource, crop: Crop): boolean {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch {
      return false;
    }
    gl.uniform4f(this.loc.crop, ...crop);
    gl.uniform1f(this.loc.n, this.lutSize || 1);
    gl.uniform1i(this.loc.useLut, this.lutSize ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }
}
