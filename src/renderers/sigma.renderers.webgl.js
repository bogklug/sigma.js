;(function(undefined) {
  'use strict';

  if (typeof sigma === 'undefined')
    throw 'sigma is not declared';

  // Initialize packages:
  sigma.utils.pkg('sigma.renderers');

  /**
   * This function is the constructor of the canvas sigma's renderer.
   *
   * @param  {sigma.classes.graph}            graph    The graph to render.
   * @param  {sigma.classes.camera}           camera   The camera.
   * @param  {configurable}           settings The sigma instance settings
   *                                           function.
   * @param  {object}                 object   The options object.
   * @return {sigma.renderers.canvas}          The renderer instance.
   */
  sigma.renderers.webgl = function(graph, camera, settings, options) {
    if (typeof options !== 'object')
      throw 'sigma.renderers.webgl: Wrong arguments.';

    if (!(options.container instanceof HTMLElement))
      throw 'Container not found.';

    var k,
        i,
        l,
        a,
        fn,
        _self = this;

    sigma.classes.dispatcher.extend(this);

    // Conrad related attributes:
    this.jobs = {};

    Object.defineProperty(this, 'conradId', {
      value: sigma.utils.id()
    });

    // Initialize main attributes:
    this.graph = graph;
    this.camera = camera;
    this.contexts = {};
    this.domElements = {};
    this.options = options;
    this.container = this.options.container;
    this.settings = (
        typeof options.settings === 'object' &&
        options.settings
      ) ?
        settings.embedObjects(options.settings) :
        settings;

    // Find the prefix:
    this.options.prefix = this.camera.readPrefix;

    // Initialize programs hash
    Object.defineProperty(this, 'nodePrograms', {
      value: {}
    });
    Object.defineProperty(this, 'edgePrograms', {
      value: {}
    });
    Object.defineProperty(this, 'objLayers', {
      value: []
    });

    // Initialize the DOM elements:
    if (this.settings(options, 'batchEdgesDrawing')) {
      this.initDOM('canvas', 'edges', true);
      this.initDOM('canvas', 'nodes', true);
    } else {
      this.initDOM('canvas', 'scene', true);
      this.contexts.nodes = this.contexts.scene;
      this.contexts.edges = this.contexts.scene;
    }

    this.initDOM('canvas', 'labels');
    this.initDOM('canvas', 'mouse');
    this.contexts.hover = this.contexts.mouse;

    // Initialize captors:
    this.captors = [];
    a = this.options.captors || [sigma.captors.mouse, sigma.captors.touch];
    for (i = 0, l = a.length; i < l; i++) {
      fn = typeof a[i] === 'function' ? a[i] : sigma.captors[a[i]];
      this.captors.push(
        new fn(
          this.domElements.mouse,
          this.camera,
          this.settings
        )
      );
    }

    // Deal with sigma events:
    sigma.misc.bindEvents.call(this, this.camera.prefix);
    sigma.misc.drawHovers.call(this, this.camera.prefix);

    this.resize();
  };




  /**
   * This method will generate the nodes and edges float arrays. This step is
   * separated from the "render" method, because to keep WebGL efficient, since
   * all the camera and middlewares are modelised as matrices and they do not
   * require the float arrays to be regenerated.
   *
   * Basically, when the user moves the camera or applies some specific linear
   * transformations, this process step will be skipped, and the "render"
   * method will efficiently refresh the rendering.
   *
   * And when the user modifies the graph colors or positions (applying a new
   * layout or filtering the colors, for instance), this "process" step will be
   * required to regenerate the float arrays.
   *
   * @return {sigma.renderers.webgl} Returns the instance itself.
   */
  sigma.renderers.webgl.prototype.process = function() {
    var a,
        i,
        j,
        l,
        k,
        type,
        renderer,
        graph = this.graph,
        options = sigma.utils.extend(options, this.options),
        defaultEdgeType = this.settings(options, 'defaultEdgeType'),
        defaultNodeType = this.settings(options, 'defaultNodeType');

    // Empty float arrays:
    this.objLayers.length = 0

    var objCompareZType = function(o1, o2) {
      var z1 = o1.obj.z || 0,
          z2 = o2.obj.z || 0;
      if (z1 < z2) {
        return 1 // Nodes need to be rendered in decreasing z order.
      }
      else if (z1 > z2) {
        return -1
      }
      else if (o1.category !== o2.category) {
        return o1.category === 'node' ? 1 : -1 // edges rendered before nodes
      }
        else {
            var t1 = o1.obj.type || 'def',
                t2 = o2.obj.type || 'def';
            if (t1 < t2) {
                return -1;
            }
            else if (t1 > t2) {
                return 1
            }
            else {
                return 0;
            }
        }
    };

    for (a = graph.nodes().map(function(n) {
      return { obj: n, category: 'node' }
    })
         .concat(graph.edges().map(function(e) {
           return { obj: e, category: 'edge' }
         }))
         .sort(objCompareZType),
         i = 0, l = a.length;
         i < l;
         i++) {
      if (i === 0 ||
          (a[i - 1].obj.z || 0) !== (a[i].obj.z || 0) ||
          a[i - 1].category !== a[i].category) {
        this.objLayers.push({
          category: a[i].category,
          floatArrays: {},
          indicesArrays: {}, // needed only for edges
        })
      }
      var floatArrays = this.objLayers[this.objLayers.length - 1].floatArrays,
          type = a[i].obj.type || {
            node: defaultNodeType,
            edge: defaultEdgeType,
          }[a[i].category],
          k = (type && {
            node: sigma.webgl.nodes,
            edge: sigma.webgl.edges,
          }[a[i].category][type]) ? type : 'def';

      if (!floatArrays[k]) {
        floatArrays[k] = {};
        floatArrays[k][{
          node: 'nodes',
          edge: 'edges',
        }[a[i].category]] = [];
      }
      floatArrays[k][{
          node: 'nodes',
          edge: 'edges',
      }[a[i].category]].push(a[i].obj);
    }

    // Push edges and nodes:
    for (j in this.objLayers) {
      var floatArrays = this.objLayers[j].floatArrays;
      for (k in floatArrays) {
        renderer = {
          node: sigma.webgl.nodes,
          edge: sigma.webgl.edges,
        }[this.objLayers[j].category][k];
        a = floatArrays[k][{
          node: 'nodes',
          edge: 'edges',
        }[this.objLayers[j].category]];

        // Creating the necessary arrays
        floatArrays[k].array = new Float32Array(
          a.length * renderer.POINTS * renderer.ATTRIBUTES
        );

        for (i = 0, l = a.length; i < l; i++) {
          if (!floatArrays[k].array)
            floatArrays[k].array = new Float32Array(
              a.length * renderer.POINTS * renderer.ATTRIBUTES
            );

          // Just check that the edge and both its extremities are visible:
          if (this.objLayers[j].category === 'node') {
            if (
              !a[i].hidden
            )
              renderer.addNode(
                a[i],
                floatArrays[k].array,
                i * renderer.POINTS * renderer.ATTRIBUTES,
                options.prefix,
                this.settings
              );
          }
          else { // this.objLayers[j].category === 'edge'
            if (
              !a[i].hidden &&
                !graph.nodes(a[i].source).hidden &&
                !graph.nodes(a[i].target).hidden
            )
              renderer.addEdge(
                a[i],
                graph.nodes(a[i].source),
                graph.nodes(a[i].target),
                floatArrays[k].array,
                i * renderer.POINTS * renderer.ATTRIBUTES,
                options.prefix,
                this.settings
              );
          }
        }

        if (typeof renderer.computeIndices === 'function')
          this.objLayers[j].indicesArrays[k] = renderer.computeIndices(
            floatArrays[k].array
          );
      }
    }

    return this;
  };

  function debounce(func, wait) {
    var timeout;
    return function() {
      var that = this, args = arguments;
      var later = function() {
	timeout = null;
	func.apply(that, args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  };

  sigma.renderers.webgl.prototype.debouncedApplyView = debounce(function() {
    // BK: Apply the camera's view to all nodes
    // and edges so that edge mouse events can work:
    this.camera.applyView(
      undefined,
      undefined,
      {
        width: this.width,
        height: this.height
      }
    );
  },
                                                                250);

  /**
   * This method renders the graph. It basically calls each program (and
   * generate them if they do not exist yet) to render nodes and edges, batched
   * per renderer.
   *
   * As in the canvas renderer, it is possible to display edges, nodes and / or
   * labels in batches, to make the whole thing way more scalable.
   *
   * @param  {?object}               params Eventually an object of options.
   * @return {sigma.renderers.webgl}        Returns the instance itself.
   */
  sigma.renderers.webgl.prototype.render = function(params) {
    var a,
        i,
        j,
        l,
        k,
        o,
        program,
        renderer,
        self = this,
        graph = this.graph,
        nodesGl = this.contexts.nodes,
        edgesGl = this.contexts.edges,
        matrix = this.camera.getMatrix(),
        options = sigma.utils.extend(params, this.options),
        drawLabels = this.settings(options, 'drawLabels'),
        drawEdges = this.settings(options, 'drawEdges'),
        drawNodes = this.settings(options, 'drawNodes');

    // Call the resize function:
    this.resize(false);

    // Check the 'hideEdgesOnMove' setting:
    if (this.settings(options, 'hideEdgesOnMove'))
      if (this.camera.isAnimated || this.camera.isMoving)
        drawEdges = false;

    // BK: Apply the camera's view to all nodes
    // and edges so that edge mouse events can work:
    this.debouncedApplyView();

    // Clear canvases:
    this.clear();

    // Translate matrix to [width/2, height/2]:
    matrix = sigma.utils.matrices.multiply(
      matrix,
      sigma.utils.matrices.translation(this.width / 2, this.height / 2)
    );

    // Kill running jobs:
    for (k in this.jobs)
      if (conrad.hasJob(k))
        conrad.killJob(k);

    for (j in this.objLayers) {

      if (this.objLayers[j].category === 'edge') {
        if (drawEdges) {
          if (this.settings(options, 'batchEdgesDrawing'))
            (function() {
              var a,
                  k,
                  i,
                  id,
                  job,
                  arr,
                  end,
                  start,
                  indices,
                  renderer,
                  batchSize,
                  currentProgram;

              var edgeFloatArrays = this.objLayers[j].floatArrays;

              id = 'edges_' + this.conradId;
              batchSize = this.settings(options, 'webglEdgesBatchSize');
              a = Object.keys(edgeFloatArrays);

              if (!a.length)
                return;
              i = 0;
              renderer = sigma.webgl.edges[a[i]];
              arr = edgeFloatArrays[a[i]].array;
              indices = this.objLayers[j].indicesArrays[a[i]];
              start = 0;
              end = Math.min(
                start + batchSize * renderer.POINTS,
                arr.length / renderer.ATTRIBUTES
              );

              job = function() {
                // Check program:
                if (!this.edgePrograms[a[i]])
                  this.edgePrograms[a[i]] = renderer.initProgram(edgesGl);

                // BK: to compute curvedArrow geometry camera ration is needed
                // and therefore no computations can be done in addEdges and
                // everything has to go to render and we need a list of edges
                // (edgesUsed) in render.
                var edges = edgeFloatArrays[k].edges,
                    edgesUsed = {},
                    jj;

                for (jj = 0, l = edges.length; jj < l; jj++) {

                  // Just check that the edge and both its extremities are visible:
                  if (
                    !edges[jj].hidden &&
                      !graph.nodes(edges[jj].source).hidden &&
                      !graph.nodes(edges[jj].target).hidden
                  )
                    edgesUsed[jj] = edges[jj];
                }

                if (start < end) {
                  edgesGl.useProgram(this.edgePrograms[a[i]]);
                  renderer.render(
                    edgesGl,
                    this.edgePrograms[a[i]],
                    arr,
                    {
                      settings: this.settings,
                      matrix: matrix,
                      width: this.width,
                      height: this.height,
                      ratio: this.camera.ratio,
                      scalingRatio: this.settings(
                        options,
                        'webglOversamplingRatio'
                      ),
                      start: start,
                      count: end - start,
                      indicesData: indices,
                      edgesUsed: edgesUsed,
                      graph: graph,
                      options: options,
                    }
                  );
                }

                // Catch job's end:
                if (
                  end >= arr.length / renderer.ATTRIBUTES &&
                    i === a.length - 1
                ) {
                  delete this.jobs[id];
                  return false;
                }

                if (end >= arr.length / renderer.ATTRIBUTES) {
                  i++;
                  arr = edgeFloatArrays[a[i]].array;
                  renderer = sigma.webgl.edges[a[i]];
                  start = 0;
                  end = Math.min(
                    start + batchSize * renderer.POINTS,
                    arr.length / renderer.ATTRIBUTES
                  );
                } else {
                  start = end;
                  end = Math.min(
                    start + batchSize * renderer.POINTS,
                    arr.length / renderer.ATTRIBUTES
                  );
                }

                return true;
              };

              this.jobs[id] = job;
              conrad.addJob(id, job.bind(this));
            }).call(this);
          else {

            var edgeFloatArrays = this.objLayers[j].floatArrays;

            for (k in edgeFloatArrays) {
              renderer = sigma.webgl.edges[k];

              // Check program:
              if (!this.edgePrograms[k])
                this.edgePrograms[k] = renderer.initProgram(edgesGl);

              // BK: to compute curvedArrow geometry camera ration is needed
              // and therefore no computations can be done in addEdges and
              // everything has to go to render and we need a list of edges
              // (edgesUsed) in render.
              var edges = edgeFloatArrays[k].edges,
                  edgesUsed = {},
                  jj;

              for (jj = 0, l = edges.length; jj < l; jj++) {

                // Just check that the edge and both its extremities are visible:
                if (
                  !edges[jj].hidden &&
                    !graph.nodes(edges[jj].source).hidden &&
                    !graph.nodes(edges[jj].target).hidden
                )
                  edgesUsed[jj] = edges[jj];
              }

              // Render
              if (edgeFloatArrays[k]) {
                edgesGl.useProgram(this.edgePrograms[k]);
                renderer.render(
                  edgesGl,
                  this.edgePrograms[k],
                  edgeFloatArrays[k].array,
                  {
                    settings: this.settings,
                    matrix: matrix,
                    width: this.width,
                    height: this.height,
                    ratio: this.camera.ratio,
                    scalingRatio: this.settings(options, 'webglOversamplingRatio'),
                    indicesData: this.objLayers[j].indicesArrays[k],
                    edgesUsed: edgesUsed,
                    graph: graph,
                    options: options,
                  }
                );
              }
            }
          }
        }
      }

      else { // this.objLayers[j].category === 'node'
        if (drawNodes) {
          // Enable blending:
          nodesGl.blendFunc(nodesGl.SRC_ALPHA, nodesGl.ONE_MINUS_SRC_ALPHA);
          nodesGl.enable(nodesGl.BLEND);

          var nodeFloatArrays = this.objLayers[j].floatArrays;
          for (k in nodeFloatArrays) {
            renderer = sigma.webgl.nodes[k];

            // Check program:
            if (!this.nodePrograms[k])
              this.nodePrograms[k] = renderer.initProgram(nodesGl);

            // Render
            if (nodeFloatArrays[k]) {
              nodesGl.useProgram(this.nodePrograms[k]);
              renderer.render(
                nodesGl,
                this.nodePrograms[k],
                nodeFloatArrays[k].array,
                {
                  settings: this.settings,
                  matrix: matrix,
                  width: this.width,
                  height: this.height,
                  ratio: this.camera.ratio,
                  scalingRatio: this.settings(options, 'webglOversamplingRatio')
                }
              );
            }
          }
        }
      }
    }

    if (drawLabels) {
      a = this.camera.quadtree.area(
        this.camera.getRectangle(this.width, this.height)
      );

      // BK: the following fragment is still necessary
      // even though we have already called applyView for all
      // nodes and edges so that edge mouse events work,
      // because that call is debounced and might not have
      // executed yet when the labels are drawn.
      // Apply camera view to these nodes:
      this.camera.applyView(
        undefined,
        undefined,
        {
          nodes: a,
          edges: [],
          width: this.width,
          height: this.height
        }
      );

      o = function(key) {
        return self.settings({
          prefix: self.camera.prefix
        }, key);
      };

      for (i = 0, l = a.length; i < l; i++)
        if (!a[i].hidden)
          (
            sigma.canvas.labels[
              a[i].type ||
              this.settings(options, 'defaultNodeType')
            ] || sigma.canvas.labels.def
          )(a[i], this.contexts.labels, o);
    }

    this.dispatchEvent('render');

    return this;
  };




  /**
   * This method creates a DOM element of the specified type, switches its
   * position to "absolute", references it to the domElements attribute, and
   * finally appends it to the container.
   *
   * @param  {string}   tag   The label tag.
   * @param  {string}   id    The id of the element (to store it in
   *                          "domElements").
   * @param  {?boolean} webgl Will init the WebGL context if true.
   */
  sigma.renderers.webgl.prototype.initDOM = function(tag, id, webgl) {
    var gl,
        dom = document.createElement(tag),
        self = this;

    dom.style.position = 'absolute';
    dom.setAttribute('class', 'sigma-' + id);

    this.domElements[id] = dom;
    this.container.appendChild(dom);

    if (tag.toLowerCase() === 'canvas') {
      this.contexts[id] = dom.getContext(webgl ? 'experimental-webgl' : '2d', {
        preserveDrawingBuffer: true
      });

      // Adding webgl context loss listeners
      if (webgl) {
        dom.addEventListener('webglcontextlost', function(e) {
          e.preventDefault();
        }, false);

        dom.addEventListener('webglcontextrestored', function(e) {
          self.render();
        }, false);
      }
    }
  };

  /**
   * This method resizes each DOM elements in the container and stores the new
   * dimensions. Then, it renders the graph.
   *
   * @param  {?number}               width  The new width of the container.
   * @param  {?number}               height The new height of the container.
   * @return {sigma.renderers.webgl}        Returns the instance itself.
   */
  sigma.renderers.webgl.prototype.resize = function(w, h) {
    var k,
        oldWidth = this.width,
        oldHeight = this.height,
        pixelRatio = sigma.utils.getPixelRatio();

    if (w !== undefined && h !== undefined) {
      this.width = w;
      this.height = h;
    } else {
      this.width = this.container.offsetWidth;
      this.height = this.container.offsetHeight;

      w = this.width;
      h = this.height;
    }

    if (oldWidth !== this.width || oldHeight !== this.height) {
      for (k in this.domElements) {
        this.domElements[k].style.width = w + 'px';
        this.domElements[k].style.height = h + 'px';

        if (this.domElements[k].tagName.toLowerCase() === 'canvas') {
          // If simple 2D canvas:
          if (this.contexts[k] && this.contexts[k].scale) {
            this.domElements[k].setAttribute('width', (w * pixelRatio) + 'px');
            this.domElements[k].setAttribute('height', (h * pixelRatio) + 'px');

            if (pixelRatio !== 1)
              this.contexts[k].scale(pixelRatio, pixelRatio);
          } else {
            this.domElements[k].setAttribute(
              'width',
              (w * this.settings('webglOversamplingRatio')) + 'px'
            );
            this.domElements[k].setAttribute(
              'height',
              (h * this.settings('webglOversamplingRatio')) + 'px'
            );
          }
        }
      }
    }

    // Scale:
    for (k in this.contexts)
      if (this.contexts[k] && this.contexts[k].viewport)
        this.contexts[k].viewport(
          0,
          0,
          this.width * this.settings('webglOversamplingRatio'),
          this.height * this.settings('webglOversamplingRatio')
        );

    return this;
  };

  /**
   * This method clears each canvas.
   *
   * @return {sigma.renderers.webgl} Returns the instance itself.
   */
  sigma.renderers.webgl.prototype.clear = function() {
    this.contexts.labels.clearRect(0, 0, this.width, this.height);
    this.contexts.nodes.clear(this.contexts.nodes.COLOR_BUFFER_BIT);
    this.contexts.edges.clear(this.contexts.edges.COLOR_BUFFER_BIT);

    return this;
  };

  /**
   * This method kills contexts and other attributes.
   */
  sigma.renderers.webgl.prototype.kill = function() {
    var k,
        captor;

    // Kill captors:
    while ((captor = this.captors.pop()))
      captor.kill();
    delete this.captors;

    // Kill contexts:
    for (k in this.domElements) {
      this.domElements[k].parentNode.removeChild(this.domElements[k]);
      delete this.domElements[k];
      delete this.contexts[k];
    }
    delete this.domElements;
    delete this.contexts;
  };




  /**
   * The object "sigma.webgl.nodes" contains the different WebGL node
   * renderers. The default one draw nodes as discs. Here are the attributes
   * any node renderer must have:
   *
   * {number}   POINTS      The number of points required to draw a node.
   * {number}   ATTRIBUTES  The number of attributes needed to draw one point.
   * {function} addNode     A function that adds a node to the data stack that
   *                        will be given to the buffer. Here is the arguments:
   *                        > {object}       node
   *                        > {number}       index   The node index in the
   *                                                 nodes array.
   *                        > {Float32Array} data    The stack.
   *                        > {object}       options Some options.
   * {function} render      The function that will effectively render the nodes
   *                        into the buffer.
   *                        > {WebGLRenderingContext} gl
   *                        > {WebGLProgram}          program
   *                        > {Float32Array} data    The stack to give to the
   *                                                 buffer.
   *                        > {object}       params  An object containing some
   *                                                 options, like width,
   *                                                 height, the camera ratio.
   * {function} initProgram The function that will initiate the program, with
   *                        the relevant shaders and parameters. It must return
   *                        the newly created program.
   *
   * Check sigma.webgl.nodes.def or sigma.webgl.nodes.fast to see how it
   * works more precisely.
   */
  sigma.utils.pkg('sigma.webgl.nodes');




  /**
   * The object "sigma.webgl.edges" contains the different WebGL edge
   * renderers. The default one draw edges as direct lines. Here are the
   * attributes any edge renderer must have:
   *
   * {number}   POINTS      The number of points required to draw an edge.
   * {number}   ATTRIBUTES  The number of attributes needed to draw one point.
   * {function} addEdge     A function that adds an edge to the data stack that
   *                        will be given to the buffer. Here is the arguments:
   *                        > {object}       edge
   *                        > {object}       source
   *                        > {object}       target
   *                        > {Float32Array} data    The stack.
   *                        > {object}       options Some options.
   * {function} render      The function that will effectively render the edges
   *                        into the buffer.
   *                        > {WebGLRenderingContext} gl
   *                        > {WebGLProgram}          program
   *                        > {Float32Array} data    The stack to give to the
   *                                                 buffer.
   *                        > {object}       params  An object containing some
   *                                                 options, like width,
   *                                                 height, the camera ratio.
   * {function} initProgram The function that will initiate the program, with
   *                        the relevant shaders and parameters. It must return
   *                        the newly created program.
   *
   * Check sigma.webgl.edges.def or sigma.webgl.edges.fast to see how it
   * works more precisely.
   */
  sigma.utils.pkg('sigma.webgl.edges');




  /**
   * The object "sigma.canvas.labels" contains the different
   * label renderers for the WebGL renderer. Since displaying texts in WebGL is
   * definitely painful and since there a way less labels to display than nodes
   * or edges, the default renderer simply renders them in a canvas.
   *
   * A labels renderer is a simple function, taking as arguments the related
   * node, the renderer and a settings function.
   */
  sigma.utils.pkg('sigma.canvas.labels');
}).call(this);
