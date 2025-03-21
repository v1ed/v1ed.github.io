(() => {
  // Создаем сцену, ортографическую камеру и рендерер
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  // Uniform-переменные для шейдера
  const uniforms = {
    u_time: { value: 0.0 },
    u_resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
    u_aspect: { value: window.innerWidth / window.innerHeight },
    u_scale: { value: 2.0 },    // масштаб шума (настройте по вкусу)
    u_speed: { value: 0.05 },    // скорость смещения шума
    u_yOffset: { value: Math.random() * 100.0 },
    // Добавляем uniform для фона и цвета краев:
    u_bgColor: { value: new THREE.Color(0x202020) },  // цвет фона (черный по умолчанию)
    u_edgeColor: { value: new THREE.Color(0x303030) } // цвет краёв (белый по умолчанию)
  };

  // Вершинный шейдер – передает координаты без изменений
  const vertexShader = `
    void main() {
      gl_Position = vec4(position, 1.0);
    }
  `;

  // Фрагментный шейдер:
  // 1. Вычисляет два слоя шума, суммирует их, нормализует и постеризует (8 уровней).
  // 2. Применяет определение краёв с помощью Лапласова фильтра.
  // 3. Масштабирует ось X для поддержки широкоформатных разрешений.
  // 4. Смешивает фоновый цвет и цвет краёв в зависимости от интенсивности края.
  const fragmentShader = `
    precision mediump float;
    uniform float u_time;
    uniform vec2 u_resolution;
    uniform float u_aspect;
    uniform float u_scale;
    uniform float u_speed;
    uniform float u_yOffset;
    uniform vec3 u_bgColor;
    uniform vec3 u_edgeColor;

    // Реализация simplex noise (версия Ashima Arts)
    vec3 mod289(vec3 x) {
      return x - floor(x * (1.0 / 289.0)) * 289.0;
    }
    vec2 mod289(vec2 x) {
      return x - floor(x * (1.0 / 289.0)) * 289.0;
    }
    vec3 permute(vec3 x) {
      return mod289(((x * 34.0) + 1.0) * x);
    }
    float snoise(vec2 v){
      const vec4 C = vec4(0.211324865405187,  // (3.0 - sqrt(3.0)) / 6.0
                          0.366025403784439,  // 0.5*(sqrt(3.0)-1.0)
                         -0.577350269189626,  // -1.0 + 2.0 * C.x
                          0.024390243902439); // 1.0 / 41.0
      vec2 i  = floor(v + dot(v, C.yy));
      vec2 x0 = v - i + dot(i, C.xx);
      vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec4 x12 = x0.xyxy + C.xxzz;
      x12.xy -= i1;
      i = mod289(i);
      vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
            + i.x + vec3(0.0, i1.x, 1.0));
      vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
      m = m * m;
      m = m * m;
      vec3 x = 2.0 * fract(p * C.www) - 1.0;
      vec3 h = abs(x) - 0.5;
      vec3 ox = floor(x + 0.5);
      vec3 a0 = x - ox;
      m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
      vec3 g;
      g.x  = a0.x  * x0.x + h.x  * x0.y;
      g.yz = a0.yz * x12.xz + h.yz * x12.yw;
      return 130.0 * dot(m, g);
    }

    // Вычисляет комбинированный шум по двум слоям, нормализует результат и постеризует (8 уровней)
    float getPosterizedNoise(vec2 noiseUV) {
      float n1 = snoise(noiseUV * u_scale + vec2(u_time * u_speed, u_yOffset));
      float n2 = snoise(noiseUV * u_scale + vec2(-u_time * u_speed, u_yOffset));
      float n = (n1 + n2) / 4.0 + 0.5;
      n = floor(n * 7.0 + 0.5) / 7.0;
      return n;
    }

    // Определение краёв через Лапласов фильтр (3x3)
    float edgeDetect(vec2 noiseUV) {
      // Вычисляем смещение в noise-координатах.
      vec2 off = vec2(1.0 / u_resolution.y, 1.0 / u_resolution.y);
      float center = getPosterizedNoise(noiseUV);
      float top = getPosterizedNoise(noiseUV + vec2(0.0, off.y));
      float bottom = getPosterizedNoise(noiseUV - vec2(0.0, off.y));
      float left = getPosterizedNoise(noiseUV - vec2(off.x, 0.0));
      float right = getPosterizedNoise(noiseUV + vec2(off.x, 0.0));
      float topLeft = getPosterizedNoise(noiseUV + vec2(-off.x, off.y));
      float topRight = getPosterizedNoise(noiseUV + vec2(off.x, off.y));
      float bottomLeft = getPosterizedNoise(noiseUV + vec2(-off.x, -off.y));
      float bottomRight = getPosterizedNoise(noiseUV + vec2(off.x, -off.y));
      float laplacian = 8.0 * center - (top + bottom + left + right + topLeft + topRight + bottomLeft + bottomRight);
      return abs(laplacian);
    }

    void main() {
      // Нормализуем координаты экрана [0,1]
      vec2 uv = gl_FragCoord.xy / u_resolution.xy;
      // Для поддержки широкоформатных разрешений масштабируем ось X
      vec2 noiseUV = vec2(uv.x * u_aspect, uv.y);
      float edge = edgeDetect(noiseUV);
      // Ограничиваем значение края до [0,1]
      float t = clamp(edge, 0.0, 1.0);
      // Смешиваем фон и цвет краёв в зависимости от t
      vec3 color = mix(u_bgColor, u_edgeColor, t);
      gl_FragColor = vec4(color, 1.0);
    }
  `;

  const material = new THREE.ShaderMaterial({
    uniforms: uniforms,
    vertexShader: vertexShader,
    fragmentShader: fragmentShader
  });

  // Создаем плоскость, покрывающую весь экран
  const geometry = new THREE.PlaneBufferGeometry(2, 2);
  const quad = new THREE.Mesh(geometry, material);
  scene.add(quad);

  // Обновление размеров при изменении окна
  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    uniforms.u_resolution.value.set(window.innerWidth, window.innerHeight);
    uniforms.u_aspect.value = window.innerWidth / window.innerHeight;
  });

  // Анимация
  function animate(time) {
    uniforms.u_time.value = time * 0.001; // перевод времени в секунды
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  animate(0);

  window.wallpaperPropertyListener = {
    applyUserProperties: function(properties) {
        if (properties.backgroundcolor) {
            let customColor = properties.background.value.split(' ');
            customColor = customColor.map(function(c) {
              return Math.ceil(c * 255);
            });
            uniforms.u_bgColor = { value: new THREE.Color(`rgb(${customColor})`) }
        }
        if (properties.linescolor) {
          let customColor = properties.lines.value.split(' ');
          customColor = customColor.map(function(c) {
            return Math.ceil(c * 255);
          });
          uniforms.u_edgeColor = { value: new THREE.Color(`rgb(${customColor})`) }
        }
        if (properties.speed) {
          let speed = parse(properties.speed.value) * 0.004;
          uniforms.u_speed = { value: speed }
        }
        // Add more properties here
    },
  };
})();
