import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { ImageWithFallback } from './components/figma/ImageWithFallback';

const heroImage = new URL(
  './assets/vis_img/Sergey_Skuratov_Architects-Afi_Tower-Moscow/Sergey_Skuratov_Architects-Afi_Tower-Moscow_title.webp',
  import.meta.url
).href;

const featuredShots = [
  {
    title: 'APEX Chasovaya',
    city: 'Moscow',
    image: new URL(
      './assets/vis_img/APEX-Chasovaya-Moscow/APEX-Chasovaya-Moscow_title.webp',
      import.meta.url
    ).href,
  },
  {
    title: 'APEX Fonchenko',
    city: 'Moscow',
    image: new URL('./assets/vis_img/APEX-Fonchenko-Moscow/APEX-Fonchenko-Moscow_title.webp', import.meta.url).href,
  },
  {
    title: 'Afi Tower',
    city: 'Moscow',
    image: new URL(
      './assets/vis_img/Sergey_Skuratov_Architects-Afi_Tower-Moscow/Sergey_Skuratov_Architects-Afi_Tower-Moscow_1.webp',
      import.meta.url
    ).href,
  },
  {
    title: 'Tolbuhino',
    city: 'Moscow',
    image: new URL(
      './assets/vis_img/APEX-Residential_Tolbuhino-Moscow/APEX-Residential_Tolbuhino-Moscow_title.webp',
      import.meta.url
    ).href,
  },
];

const services = ['Architectural Visualization', 'Animation', 'High-Poly', 'Low-Poly', 'MKA-Ready Models'];

const workflow = [
  {
    step: '01',
    title: 'Синхронизация',
    text: 'Сверяем ТЗ, стадийность и требования МКА, чтобы визуал и 3D-модель не расходились.',
  },
  {
    step: '02',
    title: 'Производство',
    text: 'Параллельно ведем рендеры, анимацию и high/low-poly пакеты в одном темпе.',
  },
  {
    step: '03',
    title: 'Финальный пакет',
    text: 'Передаем кадры, анимацию и модели в структуре, готовой к подаче и презентации.',
  },
];

type SnapshotField = {
  field: string;
  description: string;
};

type SnapshotSection = {
  id: string;
  title: string;
  note: string;
  fields: SnapshotField[];
};

const importSnapshotSections: SnapshotSection[] = [
  {
    id: '01',
    title: 'Идентификация слепка',
    note: 'Базовые идентификаторы конкретной модели и файла, по которым строится отчет.',
    fields: [
      { field: 'snapshotId', description: 'Уникальный ID слепка в рамках текущей сессии.' },
      { field: 'modelId', description: 'Внутренний ID модели в импорт-пайплайне.' },
      { field: 'modelType', description: 'Определенный тип: ВПМ или НПМ.' },
      { field: 'fileName', description: 'Исходное имя файла модели (FBX/ZIP).' },
      { field: 'sourceContainer', description: 'Контейнер источника: direct file или zip entry.' },
      { field: 'capturedAt', description: 'Время фиксации слепка до модификаций сцены.' },
    ],
  },
  {
    id: '02',
    title: 'Метаданные импорта',
    note: 'Техническая информация о загрузке, необходимая для диагностики повторяемости ошибок.',
    fields: [
      { field: 'importSessionId', description: 'ID сессии импорта, объединяющий пачку файлов.' },
      { field: 'importOrder', description: 'Порядок загрузки файла в текущем сеансе.' },
      { field: 'byteSize', description: 'Размер исходного файла в байтах.' },
      { field: 'hash', description: 'Хэш исходного массива байтов (контроль идентичности).' },
      { field: 'parseDurationMs', description: 'Время парсинга до добавления в сцену.' },
      { field: 'parseWarningsRaw', description: 'Предупреждения, полученные во время чтения.' },
    ],
  },
  {
    id: '03',
    title: 'Ориентация и система координат',
    note: 'Сырые параметры из исходного файла до любых нормализаций/поворотов вьюера.',
    fields: [
      { field: 'rawUpAxis', description: 'Исходная ось Up из файла.' },
      { field: 'rawFrontAxis', description: 'Исходная ось Front из файла.' },
      { field: 'rawCoordSystem', description: 'Тип системы координат (left/right handed).' },
      { field: 'unitScaleFactor', description: 'Коэффициент единиц измерения исходной сцены.' },
      { field: 'preRotationFlags', description: 'Наличие pre-rotation и связанных флагов.' },
      { field: 'viewerTransformPlan', description: 'Какие нормализации планирует сделать вьюер.' },
    ],
  },
  {
    id: '04',
    title: 'Сводка входной сцены',
    note: 'Счетчики по сцене в исходном состоянии, до разбиений/переименований/автозамен.',
    fields: [
      { field: 'nodeCount', description: 'Количество узлов (nodes).' },
      { field: 'meshCount', description: 'Количество мешей (geometries).' },
      { field: 'materialSlotCount', description: 'Общее число material slots.' },
      { field: 'textureRefCount', description: 'Количество ссылок на текстуры.' },
      { field: 'uvSetCount', description: 'Суммарное число UV-наборов.' },
      { field: 'hasAnimationLightsCameras', description: 'Флаги наличия анимации, света, камер.' },
    ],
  },
  {
    id: '05',
    title: 'Узлы (nodes[])',
    note: 'Иерархия объектов и локальные трансформы исходной модели.',
    fields: [
      { field: 'nodeId', description: 'Уникальный ID узла.' },
      { field: 'nameRaw', description: 'Исходное имя узла.' },
      { field: 'parentId', description: 'ID родительского узла.' },
      { field: 'nodeTypeRaw', description: 'Тип узла: mesh/null/light/camera и т.д.' },
      { field: 'localTransformRaw', description: 'Позиция/поворот/масштаб до правок.' },
      { field: 'visibilityRaw', description: 'Исходная видимость узла.' },
    ],
  },
  {
    id: '06',
    title: 'Меши (meshes[])',
    note: 'Геометрические параметры и служебные признаки для проверок МКА.',
    fields: [
      { field: 'meshId', description: 'Уникальный ID меша.' },
      { field: 'meshNameRaw', description: 'Исходное имя меша.' },
      { field: 'ownerNodeId', description: 'ID узла, которому принадлежит меш.' },
      { field: 'vertexCountRaw', description: 'Количество вершин в исходном меше.' },
      { field: 'triangleCountRaw', description: 'Количество треугольников в исходном меше.' },
      { field: 'boundingBoxRaw', description: 'Габариты меша до трансформаций вьюера.' },
      { field: 'isUcXByNameRaw', description: 'Признак UCX по имени в исходных данных.' },
    ],
  },
  {
    id: '07',
    title: 'Материалы на мешах (meshMaterialsRaw[])',
    note: 'Именно первичное назначение материалов, чтобы не путать с автоподменой во вьюере.',
    fields: [
      { field: 'slotIndex', description: 'Индекс material slot на меше.' },
      { field: 'materialIdRef', description: 'Ссылка на материал в каталоге materials[].' },
      { field: 'materialNameRaw', description: 'Исходное имя материала в файле.' },
      { field: 'materialPresentInSource', description: 'Материал действительно существовал в исходном FBX.' },
      { field: 'assignedByViewer', description: 'Флаг, что материал назначен уже вьюером (не исходный).' },
      { field: 'sourceNote', description: 'Служебная причина/примечание по назначению.' },
    ],
  },
  {
    id: '08',
    title: 'UV и UDIM (uvUdimRaw)',
    note: 'Данные UV-каналов и UDIM тайлов для проверок сеток и корректности текстурирования.',
    fields: [
      { field: 'uvChannelCount', description: 'Количество UV-каналов на меше.' },
      { field: 'uvSetNamesRaw', description: 'Исходные имена UV-наборов.' },
      { field: 'uvBoundsRaw', description: 'Границы UV по каждому каналу.' },
      { field: 'udimTilesRaw', description: 'Список обнаруженных UDIM тайлов.' },
      { field: 'uvOutOfRangePercent', description: 'Доля UV вне ожидаемых диапазонов.' },
      { field: 'requiresViewerSplit', description: 'Признак, что вьюер делает split/пересборку.' },
    ],
  },
  {
    id: '09',
    title: 'Каталог материалов (materials[])',
    note: 'Параметры самих материалов до их нормализации/переименования в приложении.',
    fields: [
      { field: 'materialId', description: 'Уникальный ID материала.' },
      { field: 'materialNameRaw', description: 'Исходное имя материала.' },
      { field: 'shadingModelRaw', description: 'Исходный shading model.' },
      { field: 'opacityModeRaw', description: 'Параметры прозрачности и альфы.' },
      { field: 'twoSidedRaw', description: 'Исходный флаг двусторонности.' },
      { field: 'textureBindingsRaw', description: 'Карта текстурных слотов материала.' },
    ],
  },
  {
    id: '10',
    title: 'Текстуры и файловые ссылки (textures[])',
    note: 'Сведения о текстурах и путях, чтобы валидировать комплектность пакета.',
    fields: [
      { field: 'textureId', description: 'Уникальный ID текстуры.' },
      { field: 'filePathRaw', description: 'Исходный путь до файла текстуры.' },
      { field: 'fileName', description: 'Имя файла текстуры.' },
      { field: 'mimeOrFormatRaw', description: 'Формат/тип (png, jpg, tga и т.д.).' },
      { field: 'resolutionRaw', description: 'Ширина/высота исходной текстуры.' },
      { field: 'embedState', description: 'Состояние: embedded/external/missing.' },
    ],
  },
  {
    id: '11',
    title: 'Индексы и быстрые карты (linksAndIndex)',
    note: 'Вспомогательные структуры для быстрых проверок без повторного обхода всей сцены.',
    fields: [
      { field: 'meshByName', description: 'Индекс мешей по имени.' },
      { field: 'nodeChildrenMap', description: 'Индекс дочерних связей по узлам.' },
      { field: 'materialsById', description: 'Быстрый доступ к материалам по ID.' },
      { field: 'texturesById', description: 'Быстрый доступ к текстурам по ID.' },
      { field: 'ucxMeshIds', description: 'Список мешей, определенных как UCX.' },
      { field: 'precheckFindings', description: 'Ошибки/предупреждения, выявленные до загрузки в сцену.' },
    ],
  },
];

export default function App() {
  const [isSnapshotModalOpen, setIsSnapshotModalOpen] = useState(false);
  const year = new Date().getFullYear();

  useEffect(() => {
    if (!isSnapshotModalOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsSnapshotModalOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSnapshotModalOpen]);

  return (
    <div className="studio-shell">
      <div className="grain-overlay" aria-hidden="true" />

      <div className="page-wrap">
        <header className="topbar reveal" style={{ animationDelay: '0.05s' }}>
          <div className="brand-block">
            <a className="brand-wordmark" href="#top" aria-label="IMA Studio">
              IMA
            </a>
            <p className="brand-caption">Architectural imagery / Moscow</p>
          </div>
          <div className="top-actions">
            <button className="top-link top-link-secondary" type="button" onClick={() => setIsSnapshotModalOpen(true)}>
              Snapshot Fields
            </button>
            <a className="top-link" href="#contact">
              Start Project
            </a>
          </div>
        </header>

        <main>
          <section id="top" className="hero">
            <div className="hero-copy reveal" style={{ animationDelay: '0.14s' }}>
              <p className="eyebrow">Visualization / Animation / MKA Models</p>
              <h1 className="hero-title">
                Лаконичный визуал,
                <span>архитектурная точность.</span>
              </h1>
              <p className="hero-body">
                Студия архитектурной визуализации и анимации. Создаем high-poly и low-poly модели для МКА в Москве,
                сохраняя одну визуальную логику от первого кадра до итоговой подачи.
              </p>

              <div className="service-pills" aria-label="Услуги">
                {services.map((service) => (
                  <span key={service} className="service-pill">
                    {service}
                  </span>
                ))}
              </div>

              <div className="action-row">
                <a className="primary-button" href="#portfolio">
                  Смотреть работы
                  <ArrowUpRight size={18} />
                </a>
                <a className="secondary-button" href="#contact">
                  Бриф и расчет
                </a>
              </div>
            </div>

            <div className="hero-visual reveal" style={{ animationDelay: '0.24s' }}>
              <figure className="hero-card">
                <ImageWithFallback
                  src={heroImage}
                  alt="Архитектурная визуализация IMA Studio"
                  loading="eager"
                  className="hero-image"
                />
                <figcaption className="hero-caption">
                  <p className="hero-caption-label">Featured Case</p>
                  <p className="hero-caption-title">Afi Tower, Moscow</p>
                </figcaption>
              </figure>

              <div className="metrics-grid" role="list" aria-label="Ключевые показатели">
                <article className="metric-card" role="listitem">
                  <p className="metric-value">300+</p>
                  <p className="metric-label">Scenes Delivered</p>
                </article>
                <article className="metric-card" role="listitem">
                  <p className="metric-value">40+</p>
                  <p className="metric-label">MKA Model Packages</p>
                </article>
                <article className="metric-card" role="listitem">
                  <p className="metric-value">12</p>
                  <p className="metric-label">Long-Term Teams</p>
                </article>
              </div>
            </div>
          </section>

          <section id="portfolio" className="showcase reveal" style={{ animationDelay: '0.36s' }}>
            <div className="section-head">
              <p className="eyebrow">Selected Work</p>
              <h2 className="section-title">Ультрачистая эстетика для жилых и mixed-use проектов Москвы.</h2>
            </div>

            <div className="showcase-grid">
              {featuredShots.map((shot, index) => (
                <article key={shot.title} className={`shot-card shot-card-${index + 1}`}>
                  <ImageWithFallback src={shot.image} alt={`${shot.title}, ${shot.city}`} className="shot-image" loading="lazy" />
                  <div className="shot-overlay" />
                  <div className="shot-meta">
                    <p>{shot.title}</p>
                    <span>{shot.city}</span>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="workflow reveal" style={{ animationDelay: '0.45s' }}>
            {workflow.map((item) => (
              <article key={item.step} className="workflow-item">
                <p className="workflow-step">{item.step}</p>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </article>
            ))}
          </section>

          <section id="contact" className="contact-panel reveal" style={{ animationDelay: '0.52s' }}>
            <p className="eyebrow">Contact</p>
            <h2 className="contact-title">Если нужен визуал, который убедителен и в кадре, и в документации МКА.</h2>
            <div className="contact-actions">
              <a href="mailto:hello@ima-vision.ru">hello@ima-vision.ru</a>
              <a href="https://t.me/ima_vision" target="_blank" rel="noreferrer">
                Telegram / @ima_vision
              </a>
            </div>
          </section>
        </main>

        {isSnapshotModalOpen ? (
          <div className="snapshot-modal" role="dialog" aria-modal="true" aria-labelledby="snapshot-modal-title" onClick={() => setIsSnapshotModalOpen(false)}>
            <div className="snapshot-modal-panel" onClick={(event) => event.stopPropagation()}>
              <div className="snapshot-modal-header">
                <div>
                  <p className="snapshot-modal-eyebrow">Временная кнопка</p>
                  <h2 id="snapshot-modal-title" className="snapshot-modal-title">
                    Что сохраняем в import snapshot
                  </h2>
                  <p className="snapshot-modal-subtitle">
                    Данные фиксируются до модификаций сцены и используются для проверок ВПМ/НПМ по первичным данным.
                  </p>
                </div>
                <button className="snapshot-close-button" type="button" onClick={() => setIsSnapshotModalOpen(false)}>
                  Закрыть
                </button>
              </div>

              <div className="snapshot-modal-scroll">
                {importSnapshotSections.map((section) => (
                  <section key={section.id} className="snapshot-section">
                    <div className="snapshot-section-head">
                      <p className="snapshot-section-index">{section.id}</p>
                      <div>
                        <h3>{section.title}</h3>
                        <p>{section.note}</p>
                      </div>
                    </div>
                    <ul className="snapshot-field-list">
                      {section.fields.map((item) => (
                        <li key={`${section.id}-${item.field}`} className="snapshot-field-item">
                          <p className="snapshot-field-name">{item.field}</p>
                          <p className="snapshot-field-description">{item.description}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        <footer className="site-footer">
          <p>© {year} IMA Studio, Moscow</p>
        </footer>
      </div>
    </div>
  );
}
