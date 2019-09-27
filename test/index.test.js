const Plugin = require('../index')

function createServerlessStub() {
  return {
    service: {
      custom: {
        dns: {
          domainName: 'somedomain.example.com'
        }
      }
    }
  }
}

describe('Plugin', () => {
  it('can be created with basic settings', () => {
    const serverless = createServerlessStub()
    const options = { stage: 'staging' }
    const plugin = new Plugin(serverless, options)

    expect(plugin.serverless).toBe(serverless)
    expect(plugin.options).toBe(options)
  })

  it('will return assigned regional domain name from build', () => {
    const serverless = createServerlessStub()
    serverless.service.custom.dns.regionalDomainName = 'regional.domainname.com'

    const options = { stage: 'staging' }
    const plugin = new Plugin(serverless, options)
    var regionalDomainName = plugin.buildRegionalDomainName(['test', 'thing', 'com'])
    expect(regionalDomainName).toBe('regional.domainname.com')
  })

  it('will build regional domain name', () => {
    const serverless = createServerlessStub()
    const options = { stage: 'staging' }
    const plugin = new Plugin(serverless, options)
    var regionalDomainName = plugin.buildRegionalDomainName(['test', 'thing', 'com'])
    expect(regionalDomainName).toBe('test-staging.thing.com')
  })

  it('will setup api regional domain settings from explicit settings', async () => {
    const serverless = {
      service: {
        custom: {
          dns: {
            regionalDomainName: 'regional.domainname.com',
            'us-east-1': {
              acmCertificateArn: 'test-certificate'
            }
          }
        }
      }
    }
    const options = { stage: 'staging', region: 'us-east-1' }
    const plugin = new Plugin(serverless, options)
    plugin.regionalDomainName = 'regional.domainname.com'

    const resources = {
      Resources: { ApiRegionalDomainName: { Properties: {} } }
    }

    await plugin.prepareApiRegionalDomainSettings(resources)

    expect(resources.Resources.ApiRegionalDomainName.Properties.DomainName).toBe(
      'regional.domainname.com'
    )
    expect(resources.Resources.ApiRegionalDomainName.Properties.RegionalCertificateArn).toBe(
      'test-certificate'
    )
  })

  it('will retrieve certificate if not set', async () => {
    const serverless = createServerlessStub()
    const options = { stage: 'staging', region: 'us-east-1' }
    const plugin = new Plugin(serverless, options)
    plugin.getCertArnFromHostName = () => {
      return Promise.resolve('test-cert-arn')
    }

    const resources = {
      Resources: { ApiRegionalDomainName: { Properties: {} } }
    }

    await plugin.prepareApiRegionalDomainSettings(resources)

    expect(resources.Resources.ApiRegionalDomainName.Properties.RegionalCertificateArn).toBe(
      'test-cert-arn'
    )
  })

  it('will set API regional base path defaults', async () => {
    const serverless = createServerlessStub()
    const options = { stage: 'staging', region: 'us-east-1' }
    const plugin = new Plugin(serverless, options)

    const resources = {
      Resources: {
        ApiGatewayStubDeployment: { Properties: {} },
        ApiRegionalBasePathMapping: { Properties: {} }
      }
    }

    await plugin.prepareApiRegionalBasePathMapping(resources)

    expect(resources.Resources.ApiGatewayStubDeployment.DependsOn).toBe(
      'ApiGatewayMethodProxyVarAny'
    )
    expect(resources.Resources.ApiGatewayStubDeployment.Properties.StageName).toBe('staging')
    expect(resources.Resources.ApiRegionalBasePathMapping.Properties.Stage).toBe('staging')
  })

  it('will set API Gateway Stub DependsOn', async () => {
    const serverless = createServerlessStub()
    serverless.service.custom.gatewayMethodDependency = 'SomeMethodToDependOn'

    const options = { stage: 'staging', region: 'us-east-1' }
    const plugin = new Plugin(serverless, options)

    const resources = {
      Resources: {
        ApiGatewayStubDeployment: { Properties: {} },
        ApiRegionalBasePathMapping: { Properties: {} }
      }
    }
    await plugin.prepareApiRegionalBasePathMapping(resources)

    expect(resources.Resources.ApiGatewayStubDeployment.DependsOn).toBe('SomeMethodToDependOn')
  })
})
