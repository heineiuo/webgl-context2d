import { InternalState } from './InternalState'
import { Transformer } from './Transformer'
import {
  createProgram,
  loadShader,
  isPOT,
  shaderMask,
  Vector4,
  getFragmentShaderSource,
  getVertexShaderSource,
  SubPath,
  colorStringToVec4,
} from './Utils'
import { ShaderProgram } from './ShaderProgram'

export class CanvasRenderingContext2DImplemention
  implements CanvasRenderingContext2D {
  constructor(gl: WebGLRenderingContext) {
    this.internalState = new InternalState(gl)
    this.transformer = new Transformer()
    this.gl = gl
    this.getShaderProgram()
    this.initBuffers()

    gl.viewport(0, 0, 800, 600)

    // Default white background
    gl.clearColor(1, 1, 1, 1)
    gl.clear(gl.COLOR_BUFFER_BIT) // | gl.DEPTH_BUFFER_BIT);

    // Disables writing to dest-alpha
    // gl.colorMask(true, true, true, false)

    // Depth options
    // gl.enable(gl.DEPTH_TEST)
    // gl.depthFunc(gl.LEQUAL)

    // Blending options
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE)
  }

  private gl: WebGLRenderingContext
  private internalState: InternalState
  private transformer: Transformer
  private pathVertexPositionBuffer: WebGLBuffer
  private rectVertexPositionBuffer: WebGLBuffer
  private rectVertexColorBuffer: WebGLBuffer
  private pathVertexColorBuffer: WebGLBuffer
  private shaderPool = []
  private subPaths = []
  private shaderProgram!: WebGLProgram
  private imageCache = []
  private textureCache = []
  private maxTextureSize: number
  private fillStyleToVector4 = (
    color: string | CanvasGradient | CanvasPattern
  ): Vector4 => {
    if (typeof color !== 'string') throw new Error('Only support string')
    const result = colorStringToVec4(color)
    if (result) return result
    return [0, 0, 0, 0]
  }

  rectVerts = new Float32Array([0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 0])

  private initBuffers = (): void => {
    const gl = this.gl
    this.rectVertexPositionBuffer = gl.createBuffer()
    this.rectVertexColorBuffer = gl.createBuffer()

    this.pathVertexPositionBuffer = gl.createBuffer()
    this.pathVertexColorBuffer = gl.createBuffer()

    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectVertexPositionBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.rectVerts, gl.STATIC_DRAW)
  }

  private sendTransformStack(sp: ShaderProgram): void {
    const matStack = this.transformer.matStack
    const maxIndex = this.transformer.cStack
    for (let i = 0; i <= maxIndex; i++) {
      // console.log(matStack[maxIndex - i])
      this.gl.uniformMatrix3fv(sp.uTransforms[i], false, matStack[maxIndex - i])
    }
  }

  private getShaderProgram = (
    transformStackDepth = 1,
    sMask = 0
  ): ShaderProgram => {
    const gl = this.gl
    const storedShader = this.shaderPool[transformStackDepth]
      ? this.shaderPool[transformStackDepth][sMask]
      : null
    if (storedShader) {
      gl.useProgram(storedShader)
      this.shaderProgram = storedShader
      return storedShader
    }
    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)

    gl.shaderSource(fragmentShader, getFragmentShaderSource(sMask))
    gl.compileShader(fragmentShader)

    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
      throw new Error(
        'fragment shader error: ' + gl.getShaderInfoLog(fragmentShader)
      )
    }

    const vertexShader = gl.createShader(gl.VERTEX_SHADER)
    gl.shaderSource(
      vertexShader,
      getVertexShaderSource(
        transformStackDepth,
        sMask,
        this.internalState.canvasWidth,
        this.internalState.canvasHeight
      )
    )
    gl.compileShader(vertexShader)

    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
      throw 'vertex shader error: ' + gl.getShaderInfoLog(vertexShader)
    }

    const shaderProgram: ShaderProgram = gl.createProgram()
    shaderProgram.stackDepth = transformStackDepth
    gl.attachShader(shaderProgram, fragmentShader)
    gl.attachShader(shaderProgram, vertexShader)
    gl.linkProgram(shaderProgram)

    if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
      throw 'Could not initialise shaders.'
    }

    gl.useProgram(shaderProgram)

    shaderProgram.vertexPositionAttribute = gl.getAttribLocation(
      shaderProgram,
      'aVertexPosition'
    )
    gl.enableVertexAttribArray(shaderProgram.vertexPositionAttribute)

    shaderProgram.uColor = gl.getUniformLocation(shaderProgram, 'uColor')
    shaderProgram.uSampler = gl.getUniformLocation(shaderProgram, 'uSampler')
    shaderProgram.uCropSource = gl.getUniformLocation(
      shaderProgram,
      'uCropSource'
    )

    shaderProgram.uTransforms = []
    for (let i = 0; i < transformStackDepth; ++i) {
      shaderProgram.uTransforms[i] = gl.getUniformLocation(
        shaderProgram,
        'uTransforms[' + i + ']'
      )
    }
    if (!this.shaderPool[transformStackDepth]) {
      this.shaderPool[transformStackDepth] = []
    }
    this.shaderPool[transformStackDepth][sMask] = shaderProgram
    return shaderProgram
  }

  private fillSubPath(index: number): void {
    const transform = this.transformer
    const shaderProgram = this.getShaderProgram(transform.cStack + 2, 0)

    const subPath = this.subPaths[index]
    const verts = subPath.verts

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.pathVertexPositionBuffer)
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new Float32Array(verts),
      this.gl.STATIC_DRAW
    )

    this.gl.vertexAttribPointer(
      shaderProgram.vertexPositionAttribute,
      4,
      this.gl.FLOAT,
      false,
      0,
      0
    )

    transform.pushMatrix()

    this.sendTransformStack(shaderProgram)

    const fillStyle = this.fillStyleToVector4(
      this.internalState.fillStrokeStyles.fillStyle
    )

    // console.log({ fillStyle })
    this.gl.uniform4f(
      shaderProgram.uColor,
      fillStyle[0],
      fillStyle[1],
      fillStyle[2],
      fillStyle[3]
    )

    this.gl.drawArrays(this.gl.TRIANGLE_FAN, 0, verts.length / 4)

    transform.popMatrix()
  }

  private strokeSubPath(index: number): void {
    const transformer = this.transformer
    const shaderProgram = this.getShaderProgram(transformer.cStack + 2, 0)

    const subPath = this.subPaths[index]
    const verts = subPath.verts

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.pathVertexPositionBuffer)
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new Float32Array(verts),
      this.gl.STATIC_DRAW
    )

    this.gl.vertexAttribPointer(
      shaderProgram.vertexPositionAttribute,
      4,
      this.gl.FLOAT,
      false,
      0,
      0
    )

    transformer.pushMatrix()

    this.sendTransformStack(shaderProgram)
    const strokeStyle = this.internalState.fillStrokeStyles.strokeStyle

    this.gl.uniform4f(
      shaderProgram.uColor,
      strokeStyle[0],
      strokeStyle[1],
      strokeStyle[2],
      strokeStyle[3]
    )

    if (subPath.closed) {
      this.gl.drawArrays(this.gl.LINE_LOOP, 0, verts.length / 4)
    } else {
      this.gl.drawArrays(this.gl.LINE_STRIP, 0, verts.length / 4)
    }

    transformer.popMatrix()
  }

  private drawImage2d = (
    image: CanvasImageSource,
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number
  ): void => {
    const gl = this.gl
    const transform = this.transformer
    const args = [image, a, b, c, d, e, f, g, h].filter(
      item => typeof item !== 'undefined'
    )

    transform.pushMatrix()

    let sMask = shaderMask.texture
    let doCrop = false

    //drawImage(image, dx, dy)
    if (args.length === 3) {
      transform.translate(a, b)
      transform.scale(image.width, image.height)
    }

    //drawImage(image, dx, dy, dw, dh)
    else if (args.length === 5) {
      transform.translate(a, b)
      transform.scale(c, d)
    }

    //drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)
    else if (args.length === 9) {
      transform.translate(e, f)
      transform.scale(g, h)
      sMask = sMask | shaderMask.crop
      doCrop = true
    }

    const shaderProgram = this.getShaderProgram(transform.cStack, sMask)
    // console.log({ shaderProgram })

    const cacheIndex = this.imageCache.indexOf(image)

    let texture = cacheIndex !== -1 ? this.textureCache[cacheIndex] : null
    if (!texture) {
      texture = {
        obj: gl.createTexture(),
        index: this.textureCache.push(this),
      }

      this.imageCache.push(image)

      gl.bindTexture(gl.TEXTURE_2D, texture.obj)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

      // Enable Mip mapping on power-of-2 textures
      if (isPOT(image.width) && isPOT(image.height)) {
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MIN_FILTER,
          gl.LINEAR_MIPMAP_LINEAR
        )
        gl.generateMipmap(gl.TEXTURE_2D)
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      }

      // Unbind texture
      gl.bindTexture(gl.TEXTURE_2D, null)
    }

    if (doCrop) {
      gl.uniform4f(
        shaderProgram.uCropSource,
        a / image.width,
        b / image.height,
        c / image.width,
        d / image.height
      )
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectVertexPositionBuffer)
    gl.vertexAttribPointer(
      shaderProgram.vertexPositionAttribute,
      4,
      gl.FLOAT,
      false,
      0,
      0
    )

    gl.bindTexture(gl.TEXTURE_2D, texture.obj)
    gl.activeTexture(gl.TEXTURE0)

    gl.uniform1i(shaderProgram.uSampler, 0)

    this.sendTransformStack(shaderProgram)
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4)

    transform.popMatrix()
  }

  drawImage3d = (image: ImageData): void => {
    const gl = this.gl
    const fragmentShader = `precision mediump float;

    // our texture
    uniform sampler2D u_image;
    
    // the texCoords passed in from the vertex shader.
    varying vec2 v_texCoord;
    
    void main() {
       gl_FragColor = texture2D(u_image, v_texCoord);
    }`

    const vertexShader = `attribute vec2 a_position;

    uniform mat3 u_matrix;
    
    varying vec2 v_texCoord;
    
    void main() {
       gl_Position = vec4(u_matrix * vec3(a_position, 1), 1);
    
       // because we're using a unit quad we can just use
       // the same data for our texcoords.
       v_texCoord = a_position;  
    }`

    const shaders = [
      loadShader(gl, fragmentShader, gl.FRAGMENT_SHADER),
      loadShader(gl, vertexShader, gl.VERTEX_SHADER),
    ]
    const program = createProgram(gl, shaders)
    gl.useProgram(program)

    // look up where the vertex data needs to go.
    const positionLocation = gl.getAttribLocation(program, 'a_position')

    // look up uniform locations
    // const uImageLoc = gl.getUniformLocation(program, 'u_image')
    const uMatrixLoc = gl.getUniformLocation(program, 'u_matrix')

    // provide texture coordinates for the rectangle.
    const positionBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        0.0,
        0.0,
        1.0,
        0.0,
        0.0,
        1.0,
        0.0,
        1.0,
        1.0,
        0.0,
        1.0,
        1.0,
      ]),
      gl.STATIC_DRAW
    )
    gl.enableVertexAttribArray(positionLocation)
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)

    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)

    // Set the parameters so we can render any size image.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

    // Upload the image into the texture.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)

    const dstX = 20
    const dstY = 30
    const dstWidth = 64
    const dstHeight = 64

    // convert dst pixel coords to clipspace coords
    const clipX = (dstX / gl.canvas.width) * 2 - 1
    const clipY = (dstY / gl.canvas.height) * -2 + 1
    const clipWidth = (dstWidth / gl.canvas.width) * 2
    const clipHeight = (dstHeight / gl.canvas.height) * -2

    // build a matrix that will stretch our
    // unit quad to our desired size and location
    gl.uniformMatrix3fv(uMatrixLoc, false, [
      clipWidth,
      0,
      0,
      0,
      clipHeight,
      0,
      clipX,
      clipY,
      1,
    ])

    // Draw the rectangle.
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  // ------------------ END OF PRIVATE METHODS --------------------------------------

  get canvas(): HTMLCanvasElement {
    return null
  }

  get globalAlpha(): number {
    return this.internalState.compositing.globalAlpha
  }

  set globalAlpha(value) {
    this.internalState.compositing.globalAlpha = value
  }

  get globalCompositeOperation(): string {
    return this.internalState.compositing.globalCompositeOperation
  }

  set globalCompositeOperation(value) {
    this.internalState.compositing.globalCompositeOperation = value
  }

  get fillStyle(): string | CanvasGradient | CanvasPattern {
    return this.internalState.fillStrokeStyles.fillStyle
  }

  set fillStyle(value) {
    if (typeof value === 'string') {
      const parsedValue = colorStringToVec4(value)
      if (parsedValue) {
        this.internalState.fillStrokeStyles.fillStyle = value
      }
    }
  }

  get strokeStyle(): string | CanvasGradient | CanvasPattern {
    return this.internalState.fillStrokeStyles.strokeStyle
  }

  set strokeStyle(value) {
    this.internalState.fillStrokeStyles.strokeStyle = value
  }

  get filter(): string {
    return this.internalState.filter
  }

  set filter(value) {
    this.internalState.filter = value
  }

  get imageSmoothingEnabled(): boolean {
    return this.internalState.imageSmoothing.imageSmoothingEnabled
  }

  set imageSmoothingEnabled(value) {
    this.internalState.imageSmoothing.imageSmoothingEnabled = value
  }

  get imageSmoothingQuality(): ImageSmoothingQuality {
    return this.internalState.imageSmoothing.imageSmoothingQuality
  }

  set imageSmoothingQuality(value) {
    this.internalState.imageSmoothing.imageSmoothingQuality = value
  }

  get lineWidth(): number {
    return this.internalState.drawingStyles.lineWidth
  }

  set lineWidth(value) {
    this.gl.lineWidth(value)
    this.internalState.drawingStyles.lineWidth = value
  }

  get lineDashOffset(): number {
    return this.internalState.drawingStyles.lineDashOffset
  }

  set lineDashOffset(value) {
    this.internalState.drawingStyles.lineDashOffset = value
  }

  // Currently unsupported attributes and their default values
  get lineCap(): CanvasLineCap {
    return this.internalState.drawingStyles.lineCap
  }

  set lineCap(value) {
    this.internalState.drawingStyles.lineCap = value
  }

  get lineJoin(): CanvasLineJoin {
    return this.internalState.drawingStyles.lineJoin
  }

  set lineJoin(value) {
    this.internalState.drawingStyles.lineJoin = value
  }

  get miterLimit(): number {
    return this.internalState.drawingStyles.miterLimit
  }

  set miterLimit(value) {
    this.internalState.drawingStyles.miterLimit = value
  }

  get shadowOffsetX(): number {
    return this.internalState.shadowStyles.shadowOffsetX
  }

  set shadowOffsetX(value) {
    this.internalState.shadowStyles.shadowOffsetX = value
  }

  get shadowOffsetY(): number {
    return this.internalState.shadowStyles.shadowOffsetY
  }

  set shadowOffsetY(value) {
    this.internalState.shadowStyles.shadowOffsetY = value
  }

  get shadowBlur(): number {
    return this.internalState.shadowStyles.shadowBlur
  }

  set shadowBlur(value) {
    this.internalState.shadowStyles.shadowBlur = value
  }

  get shadowColor(): string {
    return this.internalState.shadowStyles.shadowColor
  }

  set shadowColor(value) {
    this.internalState.shadowStyles.shadowColor = value
  }

  get font(): string {
    return this.internalState.textDrawingStyles.font
  }

  set font(value) {
    this.internalState.textDrawingStyles.font = value
  }

  get textAlign(): CanvasTextAlign {
    return this.internalState.textDrawingStyles.textAlign
  }

  set textAlign(value) {
    this.internalState.textDrawingStyles.textAlign = value
  }

  get textBaseline(): CanvasTextBaseline {
    return this.internalState.textDrawingStyles.textBaseline
  }

  set textBaseline(value) {
    this.internalState.textDrawingStyles.textBaseline = value
  }

  get direction(): CanvasDirection {
    return this.internalState.textDrawingStyles.direction
  }

  set direction(value) {
    this.internalState.textDrawingStyles.direction = value
  }

  isPointInStroke = (arg1: any, arg2: any, arg3?: any, arg4?: any): boolean => {
    console.warn('isPointInStroke not implemented')
    return false
  }

  ellipse = (
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    anticlockwise?: boolean
  ): void => {
    console.warn('ellipse not implemented')
  }

  getLineDash = (): number[] => {
    console.warn('getLineDash not implemented')
    return []
  }

  drawImage = (
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sw?: number,
    sh?: number,
    dx?: number,
    dy?: number,
    dw?: number,
    dh?: number
  ): void => {
    // console.warn('drawImage not implemented')
    this.drawImage2d(image, sx, sy, sw, sh, dx, dy, dw, dh)
  }

  // Empty the list of subpaths so that the context once again has zero subpaths
  beginPath = (): void => {
    this.subPaths = []
  }

  clip = (arg1?: any, arg2?: any): void => {
    console.warn('clip not implemented')
    return
  }

  fill = (arg1?: any, arg2?: any): void => {
    for (let i = 0; i < this.subPaths.length; i++) {
      this.fillSubPath(i)
    }
  }

  isPointInPath = (path: any, x: any, y?: any, fillRule?: any): boolean => {
    console.warn('isPointInPath not implemented')
    return false
  }

  stroke = (path?: Path2D): void => {
    for (let i = 0; i < this.subPaths.length; i++) {
      this.strokeSubPath(i)
    }

    this.gl.flush()
    // this.gl.endFrameEXP()
  }

  setLineDash = (segments: number[]): void => {
    console.warn('setLineDash not implemented')
    return
  }

  getTransform = (): DOMMatrix => {
    console.warn('getTransform not implemented')
    return {} as DOMMatrix
  }

  resetTransform = (): void => {
    return
  }

  drawFocusIfNeeded = (arg1: any, arg2?: any): void => {
    console.warn('drawFocusIfNeeded not implemented')
    return
  }

  scrollPathIntoView = (path?: Path2D): void => {
    console.warn('scrollPathIntoView not implemented')
    return
  }

  createLinearGradient = (
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ): CanvasGradient => {
    console.warn('createLinearGradient not implemented')
    return {} as CanvasGradient
  }

  createPattern = (
    image: CanvasImageSource,
    repetition: string
  ): CanvasPattern | null => {
    console.warn('createLinearGradient not implemented')
    return
  }

  createRadialGradient = (
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number
  ): CanvasGradient => {
    console.warn('createLinearGradient not implemented')
    return {} as CanvasGradient
  }

  // Need a solution for drawing text that isnt stupid slow
  fillText = (text: string, x: number, y: number, maxWidth?: number): void => {
    /*
      textCtx.clearRect(0, 0, this.options.width, this.options.height);
      textCtx.fillStyle = gl.fillStyle;
      textCtx.fillText(text, x, y);

      gl.drawImage(textCanvas, 0, 0);
      */
  }

  strokeText = (
    text: string,
    x: number,
    y: number,
    maxWidth?: number
  ): void => {
    console.warn('strokeText not implemented')
  }

  measureText = (text: string): TextMetrics => {
    console.warn('measureText not implemented')
    return {} as TextMetrics
  }

  save = (): void => {
    this.transformer.pushMatrix()
    this.internalState.save()
  }

  restore = (): void => {
    this.transformer.popMatrix()
    this.internalState.restore()
  }

  translate = (x: number, y: number): void => {
    this.transformer.translate(x, y)
  }

  rotate = (angle: number): void => {
    this.transformer.rotate(angle)
  }

  scale = (x: number, y: number): void => {
    this.transformer.scale(x, y)
  }

  createImageData = (arg1: any, arg2?: any): ImageData => {
    // throw new Error('createImageData not implemented')
    // return this.tempCtx.createImageData(width, height);
    return new ImageData(arg1, arg2)
  }

  getImageData = (
    sx: number,
    sy: number,
    sw: number,
    sh: number
  ): ImageData => {
    console.warn('getImageData not implemented')

    return {} as ImageData

    // let data = this.tempCtx.createImageData(width, height);
    // let buffer = new Uint8Array(width * height * 4);
    // this.gl.readPixels(sx, sy, sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
    // let w = width * 4,
    //   h = height;
    // for (var i = 0, maxI = h / 2; i < maxI; ++i) {
    //   for (var j = 0, maxJ = w; j < maxJ; ++j) {
    //     let index1 = i * w + j;
    //     let index2 = (h - i - 1) * w + j;
    //     data.data[index1] = buffer[index2];
    //     data.data[index2] = buffer[index1];
    //   }
    // }
    // return data;
  }

  putImageData = (imageData, x, y): void => {
    this.drawImage(imageData, x, y)
  }

  transform = (
    m11: number,
    m12: number,
    m21: number,
    m22: number,
    dx: number,
    dy: number
  ): void => {
    const m = this.transformer.matStack[this.transformer.cStack]

    m[0] *= m11
    m[1] *= m21
    m[2] *= dx
    m[3] *= m12
    m[4] *= m22
    m[5] *= dy
    m[6] = 0
    m[7] = 0
  }

  setTransform = (
    a?: any,
    b?: any,
    c?: any,
    d?: any,
    e?: any,
    f?: any
  ): void => {
    this.transformer.setIdentity()
    this.transform(a, b, c, d, e, f)
  }

  fillRect = (x: number, y: number, width: number, height: number): void => {
    const gl = this.gl
    const transformer = this.transformer
    const shaderProgram = this.getShaderProgram(transformer.cStack + 2, 0)
    // console.log({ shaderProgram })

    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectVertexPositionBuffer)
    gl.vertexAttribPointer(
      shaderProgram.vertexPositionAttribute,
      4,
      gl.FLOAT,
      false,
      0,
      0
    )

    transformer.pushMatrix()

    transformer.translate(x, y)
    transformer.scale(width, height)

    this.sendTransformStack(shaderProgram)
    const fillStyle = colorStringToVec4(
      this.internalState.fillStrokeStyles.fillStyle
    )

    // console.log({ fillStyle })

    gl.uniform4f(
      shaderProgram.uColor,
      fillStyle[0],
      fillStyle[1],
      fillStyle[2],
      fillStyle[3]
    )

    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4)

    transformer.popMatrix()
  }

  strokeRect = (x: number, y: number, width: number, height: number): void => {
    const transform = this.transformer
    const shaderProgram = this.getShaderProgram(transform.cStack + 2, 0)
    const gl = this.gl

    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectVertexPositionBuffer)
    gl.vertexAttribPointer(
      shaderProgram.vertexPositionAttribute,
      4,
      gl.FLOAT,
      false,
      0,
      0
    )

    transform.pushMatrix()

    transform.translate(x, y)
    transform.scale(width, height)

    this.sendTransformStack(shaderProgram)
    const strokeStyle = this.internalState.fillStrokeStyles.strokeStyle

    gl.uniform4f(
      shaderProgram.uColor,
      strokeStyle[0],
      strokeStyle[1],
      strokeStyle[2],
      strokeStyle[3]
    )

    gl.drawArrays(gl.LINE_LOOP, 0, 4)

    transform.popMatrix()
  }

  clearRect = (x: number, y: number, width: number, height: number): void => {
    console.warn('clearRect not implemented')
  }

  // Mark last subpath as closed and create a new subpath with the same starting point as the previous subpath
  closePath = (): void => {
    const { subPaths } = this
    if (subPaths.length) {
      // Mark last subpath closed.
      const prevPath = subPaths[subPaths.length - 1]
      const startX = prevPath.verts[0]
      const startY = prevPath.verts[1]
      prevPath.closed = true

      // Create new subpath using the starting position of previous subpath
      const newPath = new SubPath(startX, startY)
      subPaths.push(newPath)
    }
  }

  // Create a new subpath with the specified point as its first (and only) point
  moveTo = (x: number, y: number): void => {
    this.subPaths.push(new SubPath(x, y))
  }

  lineTo = (x: number, y: number): void => {
    if (this.subPaths.length) {
      this.subPaths[this.subPaths.length - 1].verts.push(x, y, 0, 0)
    } else {
      // Create a new subpath if none currently exist
      this.moveTo(x, y)
    }
  }

  quadraticCurveTo = (cpx: number, cpy: number, x: number, y: number): void => {
    console.warn('quadraticCurveTo not implemented')
  }

  bezierCurveTo = (
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number
  ) => {
    console.warn('bezierCurveTo not implemented')
  }

  arcTo = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    radius: number
  ): void => {
    console.warn('arcTo not implemented')
  }

  // Adds a closed rect subpath and creates a new subpath
  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y)
    this.lineTo(x + w, y)
    this.lineTo(x + w, y + h)
    this.lineTo(x, y + h)
    this.closePath()
  }

  arc = (
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    anticlockwise?: boolean
  ): void => {
    console.warn('arc not implemented')
  }
}
