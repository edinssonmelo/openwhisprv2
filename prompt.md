Sí: con esta transcripción cambia bastante la lectura, porque aquí ya no estamos hablando solo de **Visual TNS escritorio**, sino también de **Portal TNS**, que es la versión **web/nube**.

La conclusión más importante es esta:

**TNS parece tener dos mundos relacionados, pero técnicamente distintos:**

```text
1. Visual TNS clásico
   → Software Windows / escritorio
   → Firebird local o servidor LAN
   → Instaladores, MIDAS, IBOConsole, licencia local/servidor/USB
   → Arquitectura cliente-servidor tradicional

2. Portal TNS
   → Plataforma SaaS en nube
   → Acceso web, app, API y clientes ligeros .exe
   → Suscripción mensual/anual
   → Control de usuarios, roles, sesiones, permisos, auditoría, facturación electrónica, tienda virtual e integraciones
```

TNS confirma oficialmente que **Portal TNS es Software como Servicio SaaS** para gestión comercial, operativa y administrativa con módulos integrados, accesible desde cualquier lugar. También sus términos dicen que se accede mediante **App, WEB, API y clientes ligeros `.exe`**. ([TNS][1])

---

# 1. Qué es realmente Visual TNS / Portal TNS

**Visual TNS clásico** es un sistema administrativo-contable de escritorio. Por sus manuales e instaladores, usa módulos como Administración, Contabilidad, Facturación, Inventario, Cartera, Tesorería, Producción, POS, Nómina, Activos Fijos, CRM, Contratos, Carga, Parqueadero, Inmobiliaria, Salud, Servicios Públicos, entre otros. No es solo contabilidad; es más parecido a un **ERP contable-administrativo colombiano**. ([TNS][2])

**Portal TNS**, según la transcripción, es la evolución web/nube. Permite crear cuenta, pagar suscripción, acceder desde `portal.tns.co`, manejar usuarios, roles, sesiones, sucursales, años fiscales, terceros, artículos, prefijos, facturación, inventario, contabilidad, tienda virtual, auditoría e integraciones con DIAN/RNDC. Oficialmente TNS lo define como plataforma SaaS en nube. ([TNS][1])

La ficha técnica de Portal TNS Privado lo describe como un sistema para optimizar la gestión **administrativa, operativa y financiera**, con información en tiempo real desde cualquier equipo con internet, almacenamiento en nube, roles, permisos y log de auditoría. 

---

# 2. Arquitectura probable

## A. Visual TNS clásico

```text
[Servidor Windows]
   ├── Visual TNS
   │   ├── TNS.exe
   │   ├── Administración
   │   ├── Módulos operativos
   │   ├── CONFIG.EXE
   │   └── Visual TNS Licencia
   │
   ├── Firebird Server
   │   └── C:\DATOS TNS\EMPRESA.GDB
   │
   ├── Archivo administración
   │   └── C:\VISUAL TNS\ADMIN.GDB
   │
   └── Licencia
       ├── Activación por NIT
       ├── Serial físico
       ├── Serial disco/tarjeta
       └── Posible llave USB/HASP

[Clientes LAN]
   ├── Firebird Cliente
   ├── Acceso a \\Servidor\Visual TNS
   ├── MIDAS / librerías legacy
   └── CONFIG apuntando al servidor
```

Esto sí está bastante soportado por documentación. El manual dice que Firebird Server se instala en el servidor de la empresa y Firebird Cliente en las terminales; también menciona que el programa queda en `C:\Visual TNS`, que hay instalación de licencia y que `CONFIG.EXE` define servidor de base de datos. 

---

## B. Portal TNS nube

```text
[Usuario]
   ├── Navegador web
   ├── App móvil
   └── Cliente ligero .exe, probable wrapper o cliente remoto

        ↓ Internet

[Infraestructura TNS]
   ├── Frontend web
   ├── Backend/API
   ├── Autenticación
   ├── Control de sesiones
   ├── Motor de permisos
   ├── Módulos ERP
   ├── Integraciones DIAN / pagos / RNDC / mapas / correo
   ├── Auditoría
   └── Almacenamiento en nube
```

Aquí la base de datos ya no estaría en el equipo del cliente, sino en infraestructura TNS. Sus términos dicen que el usuario usa la infraestructura tecnológica disponible de TNS en **App, Web, API y clientes ligeros `.exe`**, según el plan adquirido. ([TNS][3])

**Por verificar:** no encontré una fuente oficial pública que diga qué motor de base de datos usa Portal TNS internamente. No se puede afirmar si Portal TNS usa Firebird, SQL Server, PostgreSQL u otro motor en la nube.

---

# 3. Tecnologías detectadas o probables

## Confirmadas o muy soportadas

| Área                     | Tecnología / componente                               | Estado                                   |
| ------------------------ | ----------------------------------------------------- | ---------------------------------------- |
| Visual TNS escritorio    | Windows `.exe`                                        | Confirmado por instaladores/manuales     |
| Base de datos Visual TNS | Firebird                                              | Confirmado                               |
| Versión Firebird legacy  | Firebird 2.5 para versiones 2012+                     | Confirmado                               |
| Archivos base Visual     | `.GDB`, `.GBK`, `.ZIP`                                | Confirmado                               |
| Configuración Visual     | `CONFIG.EXE`                                          | Confirmado                               |
| Licencia Visual          | Visual TNS Licencia                                   | Confirmado                               |
| Portal TNS               | SaaS Web/App/API/.exe ligero                          | Confirmado                               |
| Portal TNS               | Sesiones, usuarios, roles, auditoría                  | Confirmado                               |
| Portal TNS               | Facturación electrónica DIAN                          | Confirmado                               |
| Portal TNS               | Store / tienda virtual                                | Confirmado                               |
| Portal TNS               | Integración pagos PSE / Pagos TNS                     | Confirmado                               |
| Soporte                  | remoto vía herramienta tipo AnyDesk/RustDesk/Rostlets | Confirmado en instaladores/transcripción |

TNS publica instaladores separados para **Midas**, **IBOConsole**, **FireBird 2.5** y **AnyDesk**, lo cual confirma que esos componentes hacen parte del ecosistema técnico de soporte/instalación de Visual TNS clásico. ([TNS][4])

---

## Probables, pero no confirmadas

| Elemento                    | Lectura técnica                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Lenguaje Visual TNS clásico | Probablemente Delphi/Borland/Windows Forms legacy                                                                               |
| MIDAS                       | Probable dependencia Delphi/DataSnap/TClientDataSet                                                                             |
| IBOConsole / IBCONSOLE      | Herramienta de administración Firebird/InterBase                                                                                |
| Portal web                  | Podría usar tecnología tipo SPA con conexión persistente                                                                        |
| Portal login                | Los textos “Reconectando / Sesión pausada / Reanudar” se parecen a patrones de Blazor/SignalR, pero no hay confirmación pública |
| Multiempresa/multitenant    | Portal parece operar por empresa/sucursal/año fiscal, pero el aislamiento físico de datos no está confirmado                    |

Sobre MIDAS: Embarcadero documenta que aplicaciones Delphi/C++Builder que usan `TClientDataSet` o proveedores de datasets pueden requerir `Midas.dll`, así que su presencia apunta a stack Delphi/DataSnap o similar. ([Embarcadero Documentation][5])

---

# 4. Funcionamiento interno probable

## Modelo mental del sistema

TNS no está organizado como una app simple de “facturas”. Es un sistema basado en **tablas maestras + movimientos + permisos + contabilización + auditoría**.

El flujo base sería:

```text
Tablas maestras
   ├── Terceros
   ├── Artículos
   ├── Cuentas contables
   ├── Prefijos
   ├── Bodegas
   ├── Formas de pago
   ├── Centros de costos
   └── Listas de precios

        ↓

Movimientos
   ├── Facturas
   ├── Pedidos
   ├── Remisiones
   ├── Compras
   ├── Recibos de caja
   ├── Comprobantes contables
   ├── Notas de inventario
   └── Traslados

        ↓

Procesos
   ├── Asentar
   ├── Contabilizar
   ├── Actualizar inventario
   ├── Generar cartera
   ├── Enviar documento electrónico
   ├── Generar reportes
   └── Registrar auditoría
```

Esto encaja con lo que muestra la transcripción: primero crean usuarios/roles, luego terceros, prefijos, plan de cuentas, artículos, listas de precios, tienda virtual y después facturación/inventario/contabilidad.

---

# 5. Dominio de datos que se ve en la transcripción

La transcripción deja ver entidades internas muy claras:

```text
Empresa / suscripción
Sucursal
Año fiscal
Usuario
Sesión activa
Rol
Permiso
Módulo
Tabla
Acción permitida
Tercero
Dirección
Contacto
Red social
Cuenta contable
Prefijo
Resolución DIAN
Artículo
SKU
Grupo contable
Bodega
Lista de precios
Forma de pago
Documento electrónico
Factura
Pedido
Recibo de caja
Movimiento contable
Auditoría
```

Esto es importante porque muestra que el sistema tiene un diseño tipo ERP: los documentos no viven aislados; una factura toca tercero, artículo, lista de precios, inventario, bodega, forma de pago, prefijo, DIAN, contabilidad, cartera y auditoría.

---

# 6. Seguridad, usuarios y permisos

Portal TNS tiene un modelo de seguridad bastante granular:

```text
Usuario
   └── Rol
       └── Permisos por módulo
           └── Permisos por tabla / acción
               ├── Insertar
               ├── Editar
               ├── Eliminar
               ├── Ver
               ├── Imprimir
               ├── Asentar
               └── Reversar
```

La transcripción muestra que un rol puede tener acceso solo a Contabilidad, y dentro de Contabilidad permitir o negar acciones específicas sobre comprobantes, terceros, plan de cuentas y reportes.

Los términos de Portal TNS confirman que el usuario administrador asigna roles, crea usuarios, otorga o deniega permisos, y que existe log de auditoría para saber qué usuario hizo qué movimiento, cuándo y desde qué terminal. ([TNS][3])

Punto importante: según la transcripción, **no cobran por cantidad de usuarios creados, sino por sesiones/personas conectadas al mismo tiempo**. Eso debe verificarse con el plan real, porque los términos oficiales hablan de planes según usuarios, módulos, periodo o contrato, pero también reconocen monitoreo de sesiones activas. ([TNS][3])

---

# 7. Licenciamiento

## A. Visual TNS clásico

Visual TNS clásico maneja licencia local o por servidor. El manual menciona **Visual TNS Licencia**, activación con NIT, correo registrado y refresco de la aplicación de licencia. 

En la versión Oficial, además, el manual habla de serial físico, serial de tarjeta del computador, serial de disco duro y llave USB. También menciona drivers HASP para llave USB. 

Entonces, el modelo probable de Visual TNS clásico es:

```text
Licencia por empresa/NIT
+ licencia instalada en equipo o servidor
+ posible amarre a hardware
+ posible llave USB/HASP
+ posible servidor de licencia
+ módulos contratados
```

El manual de Administración confirma que `CONFIG.EXE` tiene campo para **Nombre del Servidor de Licencia**, que puede ser el mismo servidor o un equipo/IP diferente. 

---

## B. Portal TNS

Portal TNS es suscripción SaaS. Los términos oficiales dicen que el servicio se presta según plan adquirido o contrato, con modalidades por periodo, cantidad de usuarios y módulos solicitados; también dice que en caso de mora se suspende el servicio. ([TNS][6])

Según tu transcripción, el video menciona para 2026 un valor de **$80.000 mensual por una sesión/usuario conectado** y **$864.000 anual**. Eso lo tomaría como dato del video, pero **no lo encontré confirmado en una página oficial estática de precios**, así que lo dejaría como **por verificar con TNS o cotización vigente**.

Portal TNS también incluye un límite razonable de almacenamiento de **10 GB** según términos oficiales; si se supera, TNS puede cobrar almacenamiento adicional. ([TNS][3])

---

# 8. Base de datos

## Visual TNS clásico

La base clásica usa Firebird. TNS documenta que para versiones desde 2012 se usa Firebird 2.5.0.26074 Win32; para versiones antiguas puede ser Firebird 1.5 o 2.0. 

Rutas probables:

```text
C:\Visual TNS\
C:\Visual TNS\ADMIN.GDB
C:\DATOS TNS\EMPRESA.GDB
C:\Visual TNS Oficial\
C:\Visual TNS Oficial\VisualTNSLicencia\
```

El manual de Administración dice que al crear una empresa el programa agrega por defecto la extensión `.GDB` y la ruta `C:\DATOS TNS\`, y que la ruta debe ser local al servidor, no una unidad de red. 

Firebird normalmente escucha en el puerto **3050**, según documentación oficial. ([Home][7])

Para backup, Visual TNS maneja copia `.ZIP` y backup/restore `.GBK`; el manual dice que el backup Firebird recorre registros y puede ayudar a verificar integridad. 

## Portal TNS

En Portal TNS, el usuario no administra directamente la base de datos. El almacenamiento está en la nube de TNS. Los términos dicen algo delicado: si termina la suscripción, el usuario puede exportar documentos a Excel, pero TNS no se obliga a entregar la información en otro formato ni a hacer migración o desarrollo para análisis/migración. ([TNS][3])

Esto es clave: **Portal TNS te da operación en nube, pero no necesariamente acceso directo a la base de datos.**

---

# 9. Integraciones importantes

Por lo que aparece en la transcripción y documentación:

```text
DIAN
   ├── Consulta de datos de terceros
   ├── Tipos de documento
   ├── Resoluciones de facturación
   ├── Prefijos
   ├── Factura electrónica
   ├── Documentos soporte
   └── Envío masivo de documentos electrónicos

Pagos TNS / PSE
   ├── Link de pago
   ├── Registro automático de transacciones
   ├── Factura electrónica
   └── Recibos de caja

Store TNS
   ├── Publicación de artículos
   ├── Imágenes de productos
   ├── Precios
   ├── QR / compartir
   └── Posible marketplace / tienda virtual

RNDC / Ministerio de Transporte
   ├── Usuario y contraseña web service
   ├── Remesas
   ├── Manifiestos
   └── Carga de facturas electrónicas
```

TNS confirma que Pagos TNS permite pagos PSE, registro automático en facturas/recibos de caja y generación automática de factura electrónica para transmitir a DIAN. ([TNS][1])

El manual de facturación 2026 confirma funciones de envío masivo de documentos electrónicos y documentos pendientes por transmisión a DIAN. 

---

# 10. Cómo funciona una factura internamente

Una factura en Portal TNS probablemente sigue este flujo:

```text
1. Usuario entra al módulo Facturación.
2. El sistema valida sesión activa y permisos.
3. Usuario selecciona tercero.
4. Sistema trae datos DIAN o datos registrados.
5. Usuario selecciona prefijo.
6. Prefijo define resolución, formato, formas de pago, contingencia, envío electrónico.
7. Usuario selecciona artículo.
8. Artículo define IVA, grupo contable, inventario, bodega, unidad, precio.
9. Sistema calcula subtotal, IVA, descuentos, total.
10. Al guardar queda documento pendiente o borrador.
11. Al asentar:
    ├── contabiliza
    ├── afecta inventario
    ├── genera cartera o recaudo
    ├── genera documento electrónico
    ├── transmite a DIAN si está configurado
    └── registra auditoría
```

La transcripción muestra exactamente esa lógica cuando explica prefijos, artículos, precios, bodega, formas de pago, asentar y envío electrónico al asentar.

---

# 11. Diferencia clave: Visual TNS vs Portal TNS

| Tema                   | Visual TNS clásico                                | Portal TNS                                    |
| ---------------------- | ------------------------------------------------- | --------------------------------------------- |
| Tipo                   | Escritorio Windows                                | SaaS nube                                     |
| Base de datos          | Firebird local/servidor                           | Nube TNS, motor no confirmado                 |
| Instalación            | Compleja, con dependencias                        | Web/app/cliente ligero                        |
| Licencia               | Activación local, servidor, NIT, serial, USB/HASP | Suscripción mensual/anual                     |
| Usuarios               | Usuarios internos por empresa/base                | Usuarios + roles + sesiones activas           |
| Backup                 | Cliente puede hacer `.ZIP` / `.GBK`               | Exportaciones / depender de TNS               |
| Riesgo principal       | Migración, Firebird, licencia, Windows legacy     | Dependencia SaaS, exportabilidad, suscripción |
| Soporte                | AnyDesk/IBOConsole/Firebird                       | Chat, remoto, soporte web                     |
| Integraciones modernas | Más limitadas / módulos                           | DIAN, pagos, store, API, app                  |

---

# 12. Riesgos técnicos

## Visual TNS clásico

El riesgo fuerte es que es un stack antiguo. Firebird 2.5 fue liberado originalmente en 2010 y las versiones discontinuadas de Firebird ya no son mantenidas por el proyecto. ([Home][8])

Riesgos reales:

```text
- Firebird viejo.
- Dependencias 32 bits.
- MIDAS / DLLs antiguas.
- Licencia amarrada a equipo, disco o USB.
- Conflictos con Windows moderno.
- Puerto 3050 bloqueado.
- Copiar la base en caliente y dañarla.
- Actualizar programa sin actualizar base.
- Cambiar IP/nombre del servidor y romper clientes.
- Mover solo C:\Visual TNS sin C:\DATOS TNS ni licencia.
```

## Portal TNS

Riesgos distintos:

```text
- Dependencia total de internet.
- Dependencia de infraestructura TNS.
- Suscripción suspendida por mora.
- Límite de almacenamiento.
- Exportación limitada.
- No necesariamente hay acceso directo a base de datos.
- Migrar a otro sistema puede requerir exportaciones Excel/API.
- Riesgo operativo si usuarios tienen roles demasiado amplios.
- Riesgo fiscal si prefijos/DIAN quedan mal configurados.
```

---

# 13. Qué deberías pedir para entenderlo a profundidad

Para Visual TNS clásico:

```text
1. Versión exacta de Visual TNS.
2. Versión exacta de Firebird.
3. Ruta de C:\DATOS TNS.
4. Ruta de ADMIN.GDB.
5. Ruta de CONFIG.EXE.
6. Nombre/IP del servidor de datos.
7. Nombre/IP del servidor de licencia.
8. Tipo de licencia: NIT, serial, disco, tarjeta, USB/HASP.
9. Módulos contratados.
10. Número de usuarios concurrentes.
11. Método oficial de backup.
12. Último backup probado.
13. Clave supervisor / ADMIN.
14. Si hay facturación electrónica activa.
15. Si hay integraciones DIAN/RNDC/pagos.
```

Para Portal TNS:

```text
1. Plan contratado.
2. Cantidad de sesiones concurrentes.
3. Módulos incluidos.
4. Almacenamiento contratado.
5. Periodo de renovación.
6. Usuario ADMIN titular.
7. Políticas de exportación de datos.
8. Si hay API disponible para el cliente.
9. Si facturación electrónica está incluida.
10. Si Store TNS está activa.
11. Si hay integraciones con PSE/WOMPI/Pagos TNS.
12. Si hay RNDC o carga.
13. Si hay usuarios restringidos por IP.
14. Si hay auditoría habilitada.
15. Si hay contrato de soporte o solo soporte por chat.
```

---

# 14. Recomendación técnica final

Para entenderlo internamente, yo lo modelaría así:

**Visual TNS clásico** es el núcleo legacy: Windows, Firebird, módulos `.exe`, `CONFIG.EXE`, base `.GDB`, licencia local, dependencias antiguas y operación cliente-servidor.

**Portal TNS** es la capa moderna SaaS: web/app/API/cliente ligero, suscripción, sesiones concurrentes, roles, permisos, auditoría, integraciones fiscales, pagos, tienda virtual y operación en nube.

Lo más importante antes de tocarlo es no mezclar ambos mundos. Si te piden instalar o migrar **Visual TNS**, necesitas dominar Firebird, rutas, licencia y backups. Si te piden configurar **Portal TNS**, necesitas entender suscripción, usuarios, sesiones, permisos, prefijos, DIAN, tienda virtual e integraciones.

Mi recomendación práctica:

```text
1. Identifica si el cliente usa Visual TNS escritorio, Portal TNS o ambos.
2. Si es Visual: no muevas nada sin backup .GBK, copia física y revisión de licencia.
3. Si es Portal: pide plan, módulos, sesiones, usuario ADMIN, soporte y política de exportación.
4. Documenta módulos críticos: contabilidad, facturación, inventario, cartera, nómina, DIAN.
5. Revisa permisos: ningún usuario operativo debería tener rol admin completo.
6. Valida integraciones externas antes de migrar: DIAN, pagos, RNDC, tienda virtual.
7. No prometas migración hasta saber si hay acceso real a datos o solo exportación Excel/API.
```

La lectura más fina es esta: **TNS no es un solo software, es un ecosistema ERP colombiano con una versión legacy instalada y una versión SaaS moderna. Visual TNS se entiende desde infraestructura local y Firebird; Portal TNS se entiende desde SaaS, sesiones, permisos, módulos e integraciones fiscales/comerciales.**

[1]: https://www.tns.co/ "tns"
[2]: https://tns.co/manualprivado "tns"
[3]: https://www.tns.co/terminosycondicionesportaltns.php "tns"
[4]: https://tns.co/instaladores "tns"
[5]: https://docwiki.embarcadero.com/RADStudio/Athens/en/Deploying_Database_Applications?utm_source=chatgpt.com "Deploying Database Applications - RAD Studio"
[6]: https://www.tns.co/terminosycondicionesportaltns.php?utm_source=chatgpt.com "Portal TNS"
[7]: https://firebirdsql.org/rlsnotesh/config-port.html?utm_source=chatgpt.com "Chapter 9: Configuring the Port Service on Client and Server"
[8]: https://www.firebirdsql.org/en/firebird-2-5-release-description/?utm_source=chatgpt.com "Firebird 2.5 Release Description"
