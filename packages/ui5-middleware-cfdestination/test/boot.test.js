const crypto = require("crypto")
const fs = require("fs-extra")
const nock = require("nock")
const getPort = require("get-port")
const normalizer = require("@ui5/project").normalizer
const path = require("path")
const replace = require("replace-in-file")
const request = require("supertest")
const _request = require("axios")
const server = require("@ui5/server").server
const { spawn } = require("child_process")

const test = require("ava")

const waitOn = require("wait-on")

/**
 * copy showcase ui5 app for test purposes
 * and rm included ui5.yaml and xs-app.json
 *
 * @param {string} tmpDir path to copy ui5 app (that acts as the test app to)
 */
async function copyUI5app(tmpDir) {
    await fs.mkdir(tmpDir)
    const filterFn = (src, _) => {
        const yo = ["node_modules", "dist", "ui5.yaml", "xs-app.json"].find((node) => src.endsWith(node))
        return yo === undefined ? true : false
    }
    await fs.copy(path.resolve(__dirname, "../../ui5-app"), tmpDir, {
        filter: filterFn
    })
}

test.beforeEach(async (t) => {
    // copy ui5 app to a temp dir in test folder scope
    t.context.tmpDir = path.resolve(`./test/_ui5-app/${crypto.randomBytes(5).toString("hex")}`)
    await copyUI5app(t.context.tmpDir)

    // dynamic port allocation for ui5 serve
    t.context.port = {
        ui5Sserver: await getPort(),
        appRouter: await getPort()
    }
})

test.afterEach.always(async (t) => {
    // cleanup
    await fs.remove(t.context.tmpDir)
})

/**
 * @typedef UI5ServerConfig
 * @property {object} ui5
 * @property {string} ui5.yaml full path to the prepped ui5.yaml
 * @property {object} xsapp
 * @property {string} xsapp.json full path to the prepped xs-app.json
 * @property {object} defaultEnv
 * @property {string} [defaultEnv.json] full path to the prepped default-env.json
 */
/**
 * prep the ui5 server runtime for test case - ui5.yaml, xs-app.json, default-env.json
 *
 * @param {object} config
 * @param {string} config.ui5Yaml path to the ui5.yaml that should be used in the test case
 * @param {number} config.appRouterPort port the app router should be started on
 * @param {string} config.xsAppJson path to the xs-app.json that should be used in the test case
 * @param {string} [config.defaultEnvJson] path to the default-env.json that should be used in the test case
 * @param {string} config.tmpDir temporary directory all of the config files should be copied to
 * @returns {UI5ServerConfig} full path to the test fixtures of ui5.yaml, xsapp.json and defaultEnv.json (the latter is an empty object if not provided as an input parameter)
 */
async function prepUi5ServerConfig({ ui5Yaml, appRouterPort, xsAppJson, defaultEnvJson, tmpDir }) {
    // replace default port 1091 for app router w/ random port
    await fs.copyFile(path.resolve(ui5Yaml), `${tmpDir}/ui5.yaml`) // copy orig ui5.yaml test fixture
    const _ui5Yaml = await replace({ files: path.resolve(`${tmpDir}/ui5.yaml`), from: "1091", to: appRouterPort }) // replace port config in file
    const ui5 = { yaml: _ui5Yaml[0].file }

    const _xsapp = { json: path.resolve(xsAppJson) }
    const xsapp = { json: path.resolve(tmpDir, "xs-app.json") }
    // we always need the routes
    const _promises = [fs.copy(_xsapp.json, xsapp.json)]

    // auth info only on-demand
    let defaultEnv = {}
    if (defaultEnvJson) {
        const _defaultEnv = { json: path.resolve(defaultEnvJson) }
        defaultEnv = { json: path.resolve(tmpDir, "default-env.json") }
        _promises.push(fs.copy(_defaultEnv.json, defaultEnv.json))
    }

    // prep routes (+ authentication) config
    await Promise.all(_promises)

    // return resolved path to config files for re-use in tests
    return {
        ui5,
        xsapp,
        defaultEnv // this return the empty object in case no input defaultEnvJson was provided
    }
}

test("no auth in yaml, no xsuaa auth in route -> route is unprotected", async (t) => {
    const { ui5 } = await prepUi5ServerConfig({
        ui5Yaml: "./test/no-auth/ui5.yaml",
        appRouterPort: t.context.port.appRouter,
        xsAppJson: "./test/no-auth/xs-app.json",
        tmpDir: t.context.tmpDir
    })

    // start ui5-app with modified route(s) and config
    const child = spawn(`ui5 serve --port ${t.context.port.ui5Sserver} --config ${ui5.yaml}`, {
        // stdio: 'inherit', // > don't include stdout in test output
        shell: true,
        cwd: t.context.tmpDir
    })

    // wait for ui5 server and app router to boot
    await waitOn({ resources: [`tcp:${t.context.port.ui5Sserver}`, `tcp:${t.context.port.appRouter}`] })

    const app = request(`http://localhost:${t.context.port.ui5Sserver}`)
    // test for the app being started correctly
    const responseIndex = await app.get("/index.html")
    t.is(responseIndex.status, 200, "http 200 on index")

    // backend resource is accessible w/o authentication
    const responseNoAuth = await app.get("/backend/")
    t.is(responseNoAuth.status, 200)
    t.true(responseNoAuth.body.value.length >= 1, "one or more odata entities received")

    child.kill() // don't take it literally
})

/**
 * expected result: redirect to idp for route /backend
 */
test("auth in yaml, xsuaa auth in route -> route is protected", async (t) => {
    const { ui5 } = await prepUi5ServerConfig({
        ui5Yaml: "./test/auth/ui5-auth-in-yaml.yaml",
        appRouterPort: t.context.port.appRouter,
        xsAppJson: "./test/auth/xs-app.json",
        defaultEnvJson: "./test/auth/default-env.json",
        tmpDir: t.context.tmpDir
    })

    // start ui5-app with modified route(s) and config
    const child = spawn(`ui5 serve --port ${t.context.port.ui5Sserver} --config ${ui5.yaml}`, {
        // stdio: 'inherit', // > don't include stdout in test output
        shell: true,
        cwd: t.context.tmpDir
    })

    // wait for ui5 server and app router to boot
    await waitOn({ resources: [`tcp:${t.context.port.ui5Sserver}`, `tcp:${t.context.port.appRouter}`] })

    const app = request(`http://localhost:${t.context.port.ui5Sserver}`)
    // test for the app being started correctly
    const responseIndex = await app.get("/index.html")
    t.is(responseIndex.status, 200, "http 200 on index")

    // test for the redirect reponse to
    // include code for client-side redirect to idp
    const responseIdpRedirect = await app.get("/backend/")
    t.is(responseIdpRedirect.status, 200)
    t.true(
        responseIdpRedirect.text.includes("https://authentication.eu10.hana.ondemand.com/oauth/authorize"),
        "oauth endpoint redirect injected"
    )

    child.kill() // don't take it literally
})

/**
 * even though "authenticationMethod": "route" is set in xs-app.json
 * the missing config option "authenticationMethod": "route" in ui5.yaml takes precedence
 * and does not require any route protection on /backend
 */
test("no auth in yaml, xsuaa auth in route -> route is unprotected", async (t) => {
    const { ui5 } = await prepUi5ServerConfig({
        ui5Yaml: "./test/no-auth/ui5-no-auth-in-yaml.yaml",
        appRouterPort: t.context.port.appRouter,
        xsAppJson: "./test/auth/xs-app.json",
        defaultEnvJson: "./test/auth/default-env.json",
        tmpDir: t.context.tmpDir
    })

    // start ui5-app with modified route(s) and config
    const child = spawn(`ui5 serve --port ${t.context.port.ui5Sserver} --config ${ui5.yaml}`, {
        // stdio: 'inherit', // > don't include stdout in test output
        shell: true,
        cwd: t.context.tmpDir
    })

    // wait for ui5 server and app router to boot
    await waitOn({ resources: [`tcp:${t.context.port.ui5Sserver}`, `tcp:${t.context.port.appRouter}`] })

    const app = request(`http://localhost:${t.context.port.ui5Sserver}`)
    // test for the app being started correctly
    const responseIndex = await app.get("/index.html")
    t.is(responseIndex.status, 200, "http 200 on index")

    // backend resource is accessible w/o authentication
    const responseNoAuth = await app.get("/backend/")
    t.is(responseNoAuth.status, 200)
    t.true(responseNoAuth.body.value.length >= 1, "one or more odata entities received")

    child.kill() // don't take it literally
})

/**
 * protect a local html file with app router, so accessing it "proxied" via
 * ui5 serve results in a redirect to the idp
 */
test("allow localDir usage in app router for auth-protected static files", async (t) => {
    const { ui5 } = await prepUi5ServerConfig({
        ui5Yaml: "./test/auth/ui5-with-localDir.yaml",
        appRouterPort: t.context.port.appRouter,
        xsAppJson: "./test/auth/xs-app-with-localDir.json",
        defaultEnvJson: "./test/auth/default-env.json",
        tmpDir: t.context.tmpDir
    })

    // provide the static asset that is protected via app router
    await fs.copy(path.resolve("./test/auth/index1.html"), `${t.context.tmpDir}/webapp/index1.html`)

    // start ui5-app with modified route(s) and config
    const child = spawn(`ui5 serve --port ${t.context.port.ui5Sserver} --config ${ui5.yaml}`, {
        // stdio: 'inherit', // > don't include stdout in test output
        shell: true,
        cwd: t.context.tmpDir
    })

    // wait for ui5 server and app router to boot
    await waitOn({ resources: [`tcp:${t.context.port.ui5Sserver}`, `tcp:${t.context.port.appRouter}`] })

    const app = request(`http://localhost:${t.context.port.ui5Sserver}`)
    // test for the app being started correctly
    const responseIndex = await app.get("/index.html")
    t.is(responseIndex.status, 200, "http 200 on index")

    // test for the redirect reponse to /index1.html
    // include code for client-side redirect to idp
    const responseIdpRedirect = await app.get("/index1.html")
    t.is(responseIdpRedirect.status, 200)
    t.true(
        responseIdpRedirect.text.includes("https://authentication.eu10.hana.ondemand.com/oauth/authorize"),
        "oauth endpoint redirect injected"
    )

    // access /index2.html as an unprotected route to the physical index1.html
    const responseNoAuth = await app.get("/index2.html")
    t.is(responseNoAuth.status, 200)
    t.true(responseNoAuth.text.includes("placeholder"))

    child.kill() // don't take it literally
})

/**
 * multitenant context
 * expected result: redirect to subscribed subaccount idp for route /backend
 */
test("(multitenant) auth in yaml, xsuaa auth in route -> route is protected", async (t) => {
    await prepUi5ServerConfig({
        ui5Yaml: "./test/multitenant/ui5-auth-multitenant.yaml",
        appRouterPort: t.context.port.appRouter,
        xsAppJson: "./test/multitenant/xs-app.json",
        defaultEnvJson: "./test/multitenant/default-env.json",
        tmpDir: t.context.tmpDir
    })

    // mock local DNS for multi-tenany on "foo"
    nock(`http://foo.localhost:${t.context.port.appRouter}`)
        .get("/backend/")
        .reply(200, (_, __, cb) => {
            fs.readFile("./test/multitenant/mockedApprouterResonse.html", cb)
        })

    // start ui5-app with modified route(s) and config - in this test case, do things programmatically
    // with the ui5 server api instead of spawning sub-processes
    // reason: above DNS mock; nock needs to attach to the current running process and can't attach to a sub-process
    const tree = await normalizer.generateProjectTree({ cwd: t.context.tmpDir })
    let serve = await server.serve(tree, { port: t.context.port.ui5Sserver })

    // wait for ui5 server and app router to boot
    // -- probably don't need this as we're `await`ing server.serve() above?
    // await waitOn({ resources: [`tcp:${t.context.port.ui5Sserver}`, `tcp:${t.context.port.appRouter}`] })

    const app = request(`http://localhost:${t.context.port.ui5Sserver}`)
    // test for the app being started correctly
    const responseIndex = await app.get("/index.html")
    t.is(responseIndex.status, 200, "http 200 on index")

    // test for the redirect reponse to
    // include code for multi-tenant aware client-side redirect to idp
    const responseIdpRedirect = await app.get("/backend/")
    t.is(responseIdpRedirect.status, 200)
    t.true(
        responseIdpRedirect.text.includes("https://foo.authentication.eu10.hana.ondemand.com/oauth/authorize"),
        "multi-tenant oauth endpoint redirect injected"
    )

    // clean up DNS mock
    nock.cleanAll()
    nock.restore()

    // clean up programmatic ui5 server
    const _close = () =>
        new Promise((resolve, reject) => {
            serve.close((error) => {
                if (error) {
                    reject(error)
                } else {
                    resolve()
                }
            })
        })

    await _close()
})
